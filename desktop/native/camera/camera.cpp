#include <streams.h>
#include <ks.h>
#include <ksmedia.h>
#include <algorithm>
#include <chrono>
#include <cstring>
#include <new>
#include <thread>
#include <vector>
#include "../frame_queue.h"

namespace {
const CLSID cameraId = {0xb9fa819f,0x52a7,0x498d,{0xbc,0x5d,0x03,0x68,0x54,0x4f,0x81,0xd5}};
constexpr wchar_t cameraName[] = L"FrameLink Camera";
constexpr DWORD nv12 = MAKEFOURCC('N','V','1','2');
constexpr DWORD yuy2 = MAKEFOURCC('Y','U','Y','2');
struct Size { int width, height; };
constexpr Size sizes[] = {{1280,720}, {1920,1080}, {960,540}, {640,360}, {640,480}};
constexpr int rates[] = {30, 60, 24};
const GUID* const subtypes[] = {&MEDIASUBTYPE_NV12, &MEDIASUBTYPE_YUY2, &MEDIASUBTYPE_RGB32};
constexpr int formatCount = static_cast<int>(_countof(sizes) * _countof(rates) * _countof(subtypes));

int formatIndex(const GUID& subtype)
{
    for (int i = 0; i < static_cast<int>(_countof(subtypes)); ++i)
        if (subtype == *subtypes[i]) return i;
    return -1;
}

DWORD sampleSize(int width, int height, int color)
{
    return color == 0 ? width * height * 3 / 2 : width * height * (color == 1 ? 2 : 4);
}

HRESULT mediaType(int index, CMediaType* type)
{
    if (index < 0 || index >= formatCount) return E_INVALIDARG;
    int color = index / (_countof(rates) * _countof(sizes));
    int rate = rates[index % _countof(rates)];
    auto [width,height] = sizes[(index / _countof(rates)) % _countof(sizes)];
    auto* info = reinterpret_cast<VIDEOINFOHEADER*>(type->AllocFormatBuffer(sizeof(VIDEOINFOHEADER)));
    if (!info) return E_OUTOFMEMORY;
    ZeroMemory(info, sizeof(*info));
    info->AvgTimePerFrame = UNITS / rate;
    info->bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info->bmiHeader.biWidth = width;
    info->bmiHeader.biHeight = height;
    info->bmiHeader.biPlanes = 1;
    info->bmiHeader.biBitCount = color == 0 ? 12 : (color == 1 ? 16 : 32);
    info->bmiHeader.biCompression = color == 0 ? nv12 : (color == 1 ? yuy2 : BI_RGB);
    info->bmiHeader.biSizeImage = sampleSize(width,height,color);
    info->dwBitRate = info->bmiHeader.biSizeImage * 8 * rate;
    type->SetType(&MEDIATYPE_Video);
    type->SetSubtype(subtypes[color]);
    type->SetFormatType(&FORMAT_VideoInfo);
    type->SetTemporalCompression(FALSE);
    type->SetSampleSize(info->bmiHeader.biSizeImage);
    return S_OK;
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
            handle = OpenFileMappingW(FILE_MAP_READ, FALSE, FL_MAPPING);
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

void convert(BYTE* out, int width, int height, bool bottomUp, int color, const BYTE* frame, int sw, int sh)
{
    if (color == 0 && frame && width == sw && height == sh) {
        std::memcpy(out, frame, sampleSize(width, height, color));
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

class CameraPin final : public CSourceStream, public IAMStreamConfig, public IKsPropertySet {
    CMediaType selected;
    QueueReader frames;
    REFERENCE_TIME frameTime = 0;
    std::chrono::steady_clock::time_point deadline;
public:
    CameraPin(HRESULT* result, CSource* filter) : CSourceStream(NAME("FrameLink stream"), result, filter, L"Capture") {
        if (SUCCEEDED(*result)) *result = mediaType(0, &selected);
    }
    DECLARE_IUNKNOWN;
    STDMETHODIMP NonDelegatingQueryInterface(REFIID iid, void** object) override {
        if (iid == IID_IAMStreamConfig) return GetInterface(static_cast<IAMStreamConfig*>(this), object);
        if (iid == IID_IKsPropertySet) return GetInterface(static_cast<IKsPropertySet*>(this), object);
        return CSourceStream::NonDelegatingQueryInterface(iid, object);
    }
    HRESULT GetMediaType(int i, CMediaType* type) override {
        if (i < 0) return E_INVALIDARG;
        if (!i) return type->Set(selected);
        if (i >= formatCount) return VFW_S_NO_MORE_ITEMS;
        return mediaType(i, type);
    }
    HRESULT CheckMediaType(const CMediaType* type) override {
        int color = formatIndex(type->subtype);
        if (type->majortype != MEDIATYPE_Video || color < 0 || type->formattype != FORMAT_VideoInfo ||
            type->cbFormat < sizeof(VIDEOINFOHEADER) || !type->pbFormat) return VFW_E_TYPE_NOT_ACCEPTED;
        const auto* info = reinterpret_cast<const VIDEOINFOHEADER*>(type->pbFormat);
        const auto& bmp = info->bmiHeader;
        if (bmp.biHeight < -1080 || bmp.biHeight > 1080) return VFW_E_TYPE_NOT_ACCEPTED;
        const int h = std::abs(bmp.biHeight), w = bmp.biWidth;
        if (w < 160 || w > 1920 || h < 120 || w % 4 || h % 2 || bmp.biPlanes != 1 ||
            bmp.biCompression != (color == 0 ? nv12 : (color == 1 ? yuy2 : BI_RGB)) ||
            bmp.biBitCount != (color == 0 ? 12 : (color == 1 ? 16 : 32)) ||
            info->AvgTimePerFrame < UNITS / 60 || info->AvgTimePerFrame > UNITS) return VFW_E_TYPE_NOT_ACCEPTED;
        return S_OK;
    }
    HRESULT DecideBufferSize(IMemAllocator* allocator, ALLOCATOR_PROPERTIES* props) override {
        const auto* info = reinterpret_cast<const VIDEOINFOHEADER*>(m_mt.pbFormat);
        props->cbBuffer = sampleSize(info->bmiHeader.biWidth, std::abs(info->bmiHeader.biHeight), formatIndex(m_mt.subtype));
        props->cBuffers = (std::max)(props->cBuffers, 2L);
        if (!props->cbAlign) props->cbAlign = 1;
        ALLOCATOR_PROPERTIES actual{};
        const HRESULT hr = allocator->SetProperties(props, &actual);
        return FAILED(hr) ? hr : (actual.cbBuffer >= props->cbBuffer ? S_OK : E_FAIL);
    }
    HRESULT OnThreadStartPlay() override {
        frameTime = 0;
        deadline = std::chrono::steady_clock::now();
        return S_OK;
    }
    HRESULT FillBuffer(IMediaSample* sample) override {
        using namespace std::chrono;
        const auto* info = reinterpret_cast<const VIDEOINFOHEADER*>(m_mt.pbFormat);
        const auto interval = info->AvgTimePerFrame;
        const auto duration = nanoseconds(interval * 100);
        const auto now = steady_clock::now();
        if (deadline > now) std::this_thread::sleep_until(deadline);
        if (now - deadline > duration * 2) {
            frameTime += duration_cast<nanoseconds>(now - deadline).count() / 100;
            deadline = now;
            sample->SetDiscontinuity(TRUE);
        }
        BYTE* data = nullptr;
        HRESULT hr = sample->GetPointer(&data);
        if (FAILED(hr)) return hr;
        const int w = info->bmiHeader.biWidth, h = std::abs(info->bmiHeader.biHeight);
        const int color = formatIndex(m_mt.subtype);
        const long size = sampleSize(w,h,color);
        if (sample->GetSize() < size) return E_FAIL;
        try {
            const BYTE* source = frames.latest();
            convert(data, w,h,info->bmiHeader.biHeight > 0,color,source,frames.width,frames.height);
        } catch (const std::bad_alloc&) { return E_OUTOFMEMORY; }
        REFERENCE_TIME end = frameTime + interval;
        sample->SetTime(&frameTime, &end);
        sample->SetSyncPoint(TRUE);
        sample->SetActualDataLength(size);
        frameTime = end;
        deadline += duration;
        return S_OK;
    }
    STDMETHODIMP SetFormat(AM_MEDIA_TYPE* type) override {
        if (!type) return E_POINTER;
        HRESULT hr;
        CMediaType candidate(*type, &hr);
        if (FAILED(hr)) return hr;
        hr = CheckMediaType(&candidate);
        if (FAILED(hr)) return hr;
        if (IsConnected()) return candidate == m_mt ? S_OK : VFW_E_ALREADY_CONNECTED;
        return selected.Set(candidate);
    }
    STDMETHODIMP GetFormat(AM_MEDIA_TYPE** type) override {
        if (!type) return E_POINTER;
        *type = CreateMediaType(IsConnected() ? &m_mt : &selected);
        return *type ? S_OK : E_OUTOFMEMORY;
    }
    STDMETHODIMP GetNumberOfCapabilities(int* count, int* size) override {
        if (!count || !size) return E_POINTER;
        *count = formatCount;
        *size = sizeof(VIDEO_STREAM_CONFIG_CAPS);
        return S_OK;
    }
    STDMETHODIMP GetStreamCaps(int index, AM_MEDIA_TYPE** type, BYTE* caps) override {
        if (!type || !caps) return E_POINTER;
        *type = nullptr;
        if (index >= formatCount) return S_FALSE;
        CMediaType format;
        const HRESULT hr = mediaType(index, &format);
        if (FAILED(hr)) return hr;
        auto* info = reinterpret_cast<VIDEOINFOHEADER*>(format.pbFormat);
        VIDEO_STREAM_CONFIG_CAPS capability{};
        capability.guid = FORMAT_VideoInfo;
        capability.InputSize = {info->bmiHeader.biWidth, info->bmiHeader.biHeight};
        capability.MinCroppingSize = capability.MaxCroppingSize = capability.InputSize;
        capability.MinOutputSize = capability.MaxOutputSize = capability.InputSize;
        capability.OutputGranularityX = capability.OutputGranularityY = 1;
        capability.MinFrameInterval = capability.MaxFrameInterval = info->AvgTimePerFrame;
        capability.MinBitsPerSecond = capability.MaxBitsPerSecond = info->dwBitRate;
        std::memcpy(caps, &capability, sizeof(capability));
        *type = CreateMediaType(&format);
        return *type ? S_OK : E_OUTOFMEMORY;
    }
    STDMETHODIMP Set(REFGUID, DWORD, LPVOID, DWORD, LPVOID, DWORD) override { return E_NOTIMPL; }
    STDMETHODIMP Get(REFGUID set, DWORD id, LPVOID, DWORD, LPVOID data, DWORD size, DWORD* returned) override {
        if (set != AMPROPSETID_Pin) return E_PROP_SET_UNSUPPORTED;
        if (id != AMPROPERTY_PIN_CATEGORY) return E_PROP_ID_UNSUPPORTED;
        if (returned) *returned = sizeof(GUID);
        if (!data) return returned ? S_OK : E_POINTER;
        if (size < sizeof(GUID)) return HRESULT_FROM_WIN32(ERROR_INSUFFICIENT_BUFFER);
        std::memcpy(data, &PIN_CATEGORY_CAPTURE, sizeof(GUID));
        return S_OK;
    }
    STDMETHODIMP QuerySupported(REFGUID set, DWORD id, DWORD* support) override {
        if (set != AMPROPSETID_Pin) return E_PROP_SET_UNSUPPORTED;
        if (id != AMPROPERTY_PIN_CATEGORY) return E_PROP_ID_UNSUPPORTED;
        if (support) *support = KSPROPERTY_SUPPORT_GET;
        return S_OK;
    }
};

class Camera final : public CSource {
public:
    Camera(LPUNKNOWN outer, HRESULT* result) : CSource(NAME("FrameLink Camera"), outer, cameraId, result) {
        if (!new (std::nothrow) CameraPin(result, this)) *result = E_OUTOFMEMORY;
    }
    static CUnknown* WINAPI create(LPUNKNOWN outer, HRESULT* result) {
        auto* camera = new (std::nothrow) Camera(outer, result);
        if (!camera) *result = E_OUTOFMEMORY;
        return camera;
    }
};

HRESULT setRegistration(bool install)
{
    HRESULT com = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(com) && com != RPC_E_CHANGED_MODE) return com;
    HRESULT hr = S_OK;
    if (install) hr = AMovieDllRegisterServer2(TRUE);
    IFilterMapper2* mapper = nullptr;
    if (SUCCEEDED(hr)) hr = CoCreateInstance(CLSID_FilterMapper2, nullptr, CLSCTX_INPROC_SERVER,
                                             IID_PPV_ARGS(&mapper));
    if (mapper) {
        if (install) {
            const REGPINTYPES types[] = {{&MEDIATYPE_Video,&MEDIASUBTYPE_NV12},
                                         {&MEDIATYPE_Video,&MEDIASUBTYPE_YUY2},
                                         {&MEDIATYPE_Video,&MEDIASUBTYPE_RGB32}};
            const REGFILTERPINS2 pin = {REG_PINFLAG_B_OUTPUT, 1, _countof(types), types, 0, nullptr, &PIN_CATEGORY_CAPTURE};
            REGFILTER2 filter{};
            filter.dwVersion = 2;
            filter.dwMerit = MERIT_DO_NOT_USE;
            filter.cPins2 = 1;
            filter.rgPins2 = &pin;
            hr = mapper->RegisterFilter(cameraId, cameraName, nullptr, &CLSID_VideoInputDeviceCategory, nullptr, &filter);
        } else {
            mapper->UnregisterFilter(&CLSID_VideoInputDeviceCategory, nullptr, cameraId);
        }
        mapper->Release();
    }
    if (!install || FAILED(hr)) {
        const HRESULT removed = AMovieDllRegisterServer2(FALSE);
        if (!install) hr = removed;
    }
    if (SUCCEEDED(com)) CoUninitialize();
    return hr;
}
} // namespace

CFactoryTemplate g_Templates[] = {{cameraName, &cameraId, Camera::create, nullptr, nullptr}};
int g_cTemplates = _countof(g_Templates);
extern "C" BOOL WINAPI DllEntryPoint(HINSTANCE, ULONG, LPVOID);
BOOL WINAPI DllMain(HINSTANCE handle, DWORD reason, LPVOID reserved) {
    return DllEntryPoint(handle, reason, reserved);
}
STDAPI DllRegisterServer() { return setRegistration(true); }
STDAPI DllUnregisterServer() { return setRegistration(false); }
