#define WIN32_LEAN_AND_MEAN
#include "frame_queue.h"
#include <stdbool.h>
#include <sddl.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <stddef.h>

_Static_assert(offsetof(FrameSlot, data) == 24, "frame layout");
_Static_assert(offsetof(FrameQueue, slot) == 8, "queue layout");

static bool registered(void)
{
    HKEY key;
    const wchar_t *path = L"CLSID\\" FL_CLSID_TEXT L"\\InprocServer32";
    if (RegOpenKeyExW(HKEY_CLASSES_ROOT, path, 0, KEY_READ, &key) != ERROR_SUCCESS)
        return false;
    RegCloseKey(key);
    return true;
}

static bool read_frame(HANDLE input, uint8_t *data, uint32_t size)
{
    while (size) {
        DWORD count = 0;
        if (!ReadFile(input, data, size, &count, NULL) || !count) return false;
        data += count;
        size -= count;
    }
    return true;
}

int main(int argc, char **argv)
{
    if (argc == 2 && strcmp(argv[1], "--probe") == 0) return registered() ? 0 : 1;
    if (argc != 4) return 2;
    if (!registered()) {
        fputs("MISSING\n", stderr);
        return 3;
    }
    uint32_t width = (uint32_t)atoi(argv[1]), height = (uint32_t)atoi(argv[2]);
    uint32_t fps = (uint32_t)atoi(argv[3]);
    if (width < 16 || width > 1920 || height < 16 || height > 1080 ||
        width % 4 || height % 2 || (fps != 24 && fps != 30 && fps != 60)) return 2;
    HANDLE writer = CreateMutexW(NULL, FALSE, FL_WRITER);
    if (!writer) return 4;
    DWORD lock = WaitForSingleObject(writer, 0);
    if (lock != WAIT_OBJECT_0 && lock != WAIT_ABANDONED) {
        fputs("BUSY\n", stderr);
        CloseHandle(writer);
        return 5;
    }
    PSECURITY_DESCRIPTOR descriptor = NULL;
    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
            L"D:P(A;;GA;;;OW)(A;;GR;;;SY)(A;;GR;;;LS)(A;;GR;;;NS)",
            SDDL_REVISION_1, &descriptor, NULL)) return 4;
    SECURITY_ATTRIBUTES access = {sizeof(access), descriptor, FALSE};
    HANDLE mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, &access, PAGE_READWRITE, 0,
        sizeof(FrameQueue), FL_MAPPING);
    LocalFree(descriptor);
    FrameQueue *queue = mapping ? MapViewOfFile(mapping, FILE_MAP_WRITE, 0, 0, sizeof(FrameQueue)) : NULL;
    if (!queue) {
        if (mapping) CloseHandle(mapping);
        ReleaseMutex(writer);
        CloseHandle(writer);
        return 4;
    }
    InterlockedExchange(&queue->active, 0);
    InterlockedExchange(&queue->index, -1);
    fputs("READY\n", stdout);
    fflush(stdout);

    HANDLE input = GetStdHandle(STD_INPUT_HANDLE);
    LONG index = 0;
    for (;;) {
        FrameSlot *slot = &queue->slot[index];
        LONG serial = (slot->serial & ~1L) + 1;
        InterlockedExchange(&slot->serial, serial);
        if (!read_frame(input, slot->data, width * height * 3 / 2)) break;
        slot->width = width;
        slot->height = height;
        slot->tick = GetTickCount64();
        InterlockedExchange(&slot->serial, serial + 1);
        InterlockedExchange(&queue->index, index);
        InterlockedExchange(&queue->active, 1);
        index = (index + 1) % FL_SLOT_COUNT;
    }
    InterlockedExchange(&queue->active, 0);
    UnmapViewOfFile(queue);
    CloseHandle(mapping);
    ReleaseMutex(writer);
    CloseHandle(writer);
    return 0;
}
