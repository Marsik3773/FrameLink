#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>

/* OBS Virtual Camera shared-memory ABI (obs-studio, plugins/win-dshow).
   The producer and the independently installed OBS camera share NV12 buffers. */
typedef struct {
    volatile LONG write_index;
    volatile LONG read_index;
    volatile LONG state;
    uint32_t offsets[3];
    uint32_t type;
    uint32_t width;
    uint32_t height;
    uint32_t padding;
    uint64_t interval;
    uint32_t reserved[8];
} QueueHeader;

_Static_assert(sizeof(QueueHeader) == 80, "OBS header size");
_Static_assert(sizeof(LONG) == 4, "OBS atomic width");

static uint32_t align32(uint32_t size)
{
    return (size + 31u) & ~31u;
}

static bool registered(void)
{
    const wchar_t *class_path =
        L"CLSID\\{A3FCE0F5-3493-419F-958A-ABA1250EC20B}\\InprocServer32";
    HKEY key;
    if (RegOpenKeyExW(HKEY_CLASSES_ROOT, class_path, 0, KEY_READ, &key) != ERROR_SUCCESS)
        return false;
    RegCloseKey(key);
    return true;
}

static bool read_frame(HANDLE input, uint8_t *frame, uint32_t size)
{
    uint32_t offset = 0;
    while (offset < size) {
        DWORD count = 0;
        if (!ReadFile(input, frame + offset, size - offset, &count, NULL) || count == 0)
            return false;
        offset += count;
    }
    return true;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "--probe") == 0)
        return registered() ? 0 : 1;
    if (argc != 4)
        return 2;
    if (!registered()) {
        fputs("MISSING\n", stderr);
        return 3;
    }
    uint32_t width = (uint32_t)atoi(argv[1]);
    uint32_t height = (uint32_t)atoi(argv[2]);
    uint32_t fps = (uint32_t)atoi(argv[3]);
    if (width < 16 || width > 1920 || height < 16 || height > 1080 ||
        width % 4 != 0 || height % 2 != 0 || (fps != 24 && fps != 30 && fps != 60))
        return 2;
    const uint32_t frame_size = width * height * 3 / 2;
    const uint32_t stride = align32(32 + frame_size);
    const uint32_t start = align32(sizeof(QueueHeader));
    HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE, 0,
        start + 3 * stride, L"OBSVirtualCamVideo");
    if (!mapping)
        return 4;
    if (GetLastError() == ERROR_ALREADY_EXISTS) {
        fputs("BUSY\n", stderr);
        CloseHandle(mapping);
        return 5;
    }
    uint8_t *memory = MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, 0);
    if (!memory) {
        CloseHandle(mapping);
        return 4;
    }
    QueueHeader *header = (QueueHeader *)memory;
    header->width = width;
    header->height = height;
    header->interval = (10000000u + fps / 2) / fps;
    for (unsigned i = 0; i < 3; ++i)
        header->offsets[i] = start + i * stride;
    InterlockedExchange(&header->state, 1);

    fputs("READY\n", stdout);
    fflush(stdout);
    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    LARGE_INTEGER frequency;
    QueryPerformanceFrequency(&frequency);
    for (;;) {
        uint32_t index = (uint32_t)InterlockedIncrement(&header->write_index);
        uint8_t *slot = memory + header->offsets[index % 3];
        if (!read_frame(input, slot + 32, frame_size))
            break;
        LARGE_INTEGER counter;
        QueryPerformanceCounter(&counter);
        uint64_t ticks = counter.QuadPart / frequency.QuadPart * 10000000u
            + (counter.QuadPart % frequency.QuadPart) * 10000000u / frequency.QuadPart;
        memcpy(slot, &ticks, sizeof(ticks));
        InterlockedExchange(&header->read_index, (LONG)index);
        InterlockedExchange(&header->state, 2);
    }
    InterlockedExchange(&header->state, 3);
    UnmapViewOfFile(memory);
    CloseHandle(mapping);
    return 0;
}
