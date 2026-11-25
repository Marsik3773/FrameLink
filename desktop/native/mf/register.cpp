#include <windows.h>
#include <mfapi.h>
#include <mfvirtualcamera.h>
#include <cstdio>

int wmain(int argc, wchar_t** argv) {
    if (argc != 2) return 2;
    HMODULE library = LoadLibraryExW(L"mfsensorgroup.dll", nullptr, LOAD_LIBRARY_SEARCH_SYSTEM32);
    auto create = library ? reinterpret_cast<decltype(&MFCreateVirtualCamera)>(
        GetProcAddress(library, "MFCreateVirtualCamera")) : nullptr;
    if (!create) return 3;
    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (FAILED(hr)) return 1;
    hr = MFStartup(MF_VERSION);
    if (SUCCEEDED(hr)) {
        IMFVirtualCamera* camera = nullptr;
        hr = create(MFVirtualCameraType_SoftwareCameraSource, MFVirtualCameraLifetime_System,
            MFVirtualCameraAccess_AllUsers, L"FrameLink Camera",
            L"{ADC42115-88EC-4FC1-9C0C-DE43BE1ECD41}", nullptr, 0, &camera);
        if (SUCCEEDED(hr)) {
            hr = wcscmp(argv[1], L"--remove") == 0 ? camera->Remove() : camera->Start(nullptr);
            camera->Release();
        }
        MFShutdown();
    }
    CoUninitialize();
    if (FAILED(hr)) fwprintf(stderr, L"Media Foundation: 0x%08lx\n", hr);
    return FAILED(hr) ? 1 : 0;
}
