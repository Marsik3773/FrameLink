#ifndef FRAMELINK_FRAME_QUEUE_H
#define FRAMELINK_FRAME_QUEUE_H
#include <windows.h>
#include <stdint.h>

#define FL_MAPPING L"Local\\FrameLink.Camera.Frames.v1"
#define FL_WRITER L"Local\\FrameLink.Camera.Writer.v1"
#define FL_CLSID_TEXT L"{B9FA819F-52A7-498D-BC5D-0368544F81D5}"
#define FL_MF_CLSID_TEXT L"{ADC42115-88EC-4FC1-9C0C-DE43BE1ECD41}"
#define FL_FRAME_BYTES (1920 * 1080 * 3 / 2)
#define FL_SLOT_COUNT 3

typedef struct {
    volatile LONG serial;
    uint32_t width, height, reserved;
    uint64_t tick;
    uint8_t data[FL_FRAME_BYTES];
} FrameSlot;

typedef struct {
    volatile LONG active;
    volatile LONG index;
    FrameSlot slot[FL_SLOT_COUNT];
} FrameQueue;
#endif
