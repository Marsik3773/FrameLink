#pragma once
#include "frame_queue.h"
#include <algorithm>
#include <vector>
#include <cstring>
#ifdef FRAMELINK_FRAME_SERVER
#include <winternl.h>
#include <cwchar>
#endif

static HANDLE openFrameMapping() {
#ifdef FRAMELINK_FRAME_SERVER
    // Frame Server runs in session zero. Open the console user's section read-only.
    DWORD session = WTSGetActiveConsoleSessionId();
    if (session == 0xffffffff) return nullptr;
    wchar_t path[128];
    swprintf_s(path, L"\\Sessions\\%lu\\BaseNamedObjects\\FrameLink.Camera.Frames.v1", session);
    UNICODE_STRING name{};
    name.Buffer = path;
    name.Length = static_cast<USHORT>(wcslen(path) * sizeof(wchar_t));
    name.MaximumLength = name.Length + sizeof(wchar_t);
    OBJECT_ATTRIBUTES object{};
    InitializeObjectAttributes(&object, &name, OBJ_CASE_INSENSITIVE, nullptr, nullptr);
    using OpenSection = NTSTATUS (NTAPI*)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES);
    static const auto open = reinterpret_cast<OpenSection>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"), "NtOpenSection"));
    HANDLE handle = nullptr;
    return open && open(&handle, SECTION_MAP_READ, &object) >= 0 ? handle : nullptr;
#else
    return OpenFileMappingW(FILE_MAP_READ, FALSE, FL_MAPPING);
#endif
}

class QueueReader {
    HANDLE handle = nullptr;
    const FrameQueue* queue = nullptr;
    std::vector<BYTE> frame;
    ULONGLONG lastOpen = 0;
public:
    int width = 0, height = 0;
    ~QueueReader() {
        if (queue) UnmapViewOfFile(queue);
        if (handle) CloseHandle(handle);
    }
    const BYTE* latest() {
        const auto now = GetTickCount64();
        if (!queue && (!lastOpen || now - lastOpen >= 250)) {
            lastOpen = now;
            handle = openFrameMapping();
            if (handle) {
                queue = static_cast<const FrameQueue*>(MapViewOfFile(handle, FILE_MAP_READ, 0, 0, sizeof(FrameQueue)));
                if (!queue) { CloseHandle(handle); handle = nullptr; }
            }
        }
        if (!queue || !queue->active) return nullptr;
        const LONG index = queue->index;
        if (index < 0 || index >= FL_SLOT_COUNT) return nullptr;
        const auto& slot = queue->slot[index];
        const LONG serial = slot.serial;
        MemoryBarrier();
        if (serial & 1) return nullptr;
        auto w = slot.width, h = slot.height;
        if (!w || w > 1920 || !h || h > 1080 || w % 2 || h % 2 || now - slot.tick > 1800) return nullptr;
        frame.resize(w * h * 3 / 2);
        std::memcpy(frame.data(), slot.data, frame.size());
        MemoryBarrier();
        if (serial != slot.serial || !queue->active) return nullptr;
        width = static_cast<int>(w);
        height = static_cast<int>(h);
        return frame.data();
    }
};

inline void convert(BYTE* out, int width, int height, bool bottomUp, int color, const BYTE* frame, int sw, int sh)
{
    if (color == 0 && frame && width == sw && height == sh) {
        std::memcpy(out, frame, width * height * 3 / 2);
        return;
    }
    int w = width, h = height;
    if (frame) {
        if (sw * height > sh * width) h = (width * sh / sw) & ~1;
        else w = (height * sw / sh) & ~1;
    }
    const int left = ((width - w) / 2) & ~1, top = ((height - h) / 2) & ~1;
    const BYTE* uv = frame ? frame + sw * sh : nullptr;
    if (color == 0) {
        std::memset(out, 16, width * height);
        auto* outUv = out + width * height;
        std::memset(outUv, 128, width * height / 2);
        if (!frame) return;
        for (int y = 0; y < h; ++y) {
            const auto* row = frame + y * sh / h * sw;
            auto* target = out + (y + top) * width + left;
            for (int x = 0; x < w; ++x) target[x] = row[x * sw / w];
        }
        for (int y = 0; y < h / 2; ++y) {
            const auto* row = uv + y * sh / h * sw;
            auto* target = outUv + (y + top / 2) * width + left;
            for (int x = 0; x < w; x += 2) {
                int sx = (x * sw / w) & ~1;
                target[x] = row[sx];
                target[x + 1] = row[sx + 1];
            }
        }
        return;
    }
    for (int y = 0; y < height; ++y) {
        int outY = color == 2 && bottomUp ? height - 1 - y : y;
        auto* dest = out + outY * width * (color == 1 ? 2 : 4);
        int sy = frame && y >= top && y < top + h ? (y - top) * sh / h : -1;
        for (int x = 0; x < width; x += color == 1 ? 2 : 1) {
            int sx = sy >= 0 && x >= left && x < left + w ? (x - left) * sw / w : -1;
            int luma = 16, u = 128, v = 128;
            if (sx >= 0) {
                luma = frame[sy * sw + sx];
                const auto* chroma = uv + sy / 2 * sw + (sx & ~1);
                u = chroma[0]; v = chroma[1];
            }
            if (color == 1) {
                *dest++ = static_cast<BYTE>(luma); *dest++ = static_cast<BYTE>(u);
                *dest++ = sx >= 0 ? frame[sy * sw + (x + 1 - left) * sw / w] : 16;
                *dest++ = static_cast<BYTE>(v);
            } else {
                const int l = 298 * (luma - 16), cb = u - 128, cr = v - 128;
                auto channel = [](int n) { return static_cast<BYTE>(std::clamp((n + 128) >> 8, 0, 255)); };
                *dest++ = channel(l + 541 * cb);
                *dest++ = channel(l - 55 * cb - 136 * cr);
                *dest++ = channel(l + 459 * cr);
                *dest++ = 255;
            }
        }
    }
}

