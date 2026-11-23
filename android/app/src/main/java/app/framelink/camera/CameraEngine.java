package app.framelink.camera;

import android.content.Context;
import android.graphics.SurfaceTexture;
import android.hardware.camera2.*;
import android.hardware.camera2.params.StreamConfigurationMap;
import android.media.MediaCodec;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.util.Range;
import android.util.Size;
import android.view.Surface;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.Arrays;
import java.util.Comparator;
import java.util.Locale;

final class CameraEngine implements AutoCloseable {
    interface Listener {
        void packet(Wire.Packet packet);
        void configuration(JSONObject configuration);
        void state(JSONObject state);
        void preview(int width, int height, int rotation, boolean front);
        void failed(String error);
    }

    private final CameraManager manager;
    private final Listener listener;
    private final HandlerThread thread = new HandlerThread("FrameLink camera");
    private final Handler worker;
    private final String rearId, frontId;
    private SurfaceTexture texture;
    private Surface preview, encoderSurface;
    private CameraDevice camera;
    private CameraCaptureSession session;
    private CaptureRequest.Builder capture;
    private CameraCharacteristics characteristics;
    private MediaCodec encoder;
    private JSONObject configuration;
    private byte[] parameterSets = new byte[0];
    private int sessionGeneration;
    private int generation, height = 720, fps = 30, displayRotation;
    private int zoom = 100, ev, wb = CaptureRequest.CONTROL_AWB_MODE_AUTO, focus, shutter = 10000, iso = 200;
    private boolean enabled, front, manualExposure, manualFocus, needsKey = true;
    private Size size = new Size(1280, 720);
    private Range<Integer> cameraFps = new Range<>(30, 30);
    private String codecName = "";
    private double actualFps = 30;

    CameraEngine(Context context, Listener listener) {
        this.listener = listener;
        manager = context.getSystemService(CameraManager.class);
        String rear = null, selfie = null, fallback = null;
        try {
            for (String id : manager.getCameraIdList()) {
                CameraCharacteristics c = manager.getCameraCharacteristics(id);
                if (fallback == null) fallback = id;
                Integer facing = c.get(CameraCharacteristics.LENS_FACING);
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_FRONT && selfie == null) selfie = id;
                if (facing != null && facing == CameraCharacteristics.LENS_FACING_BACK && rear == null) rear = id;
            }
        } catch (CameraAccessException ignored) {}
        rearId = rear == null && selfie == null ? fallback : rear;
        frontId = selfie;
        front = rearId == null;
        thread.start();
        worker = new Handler(thread.getLooper());
        worker.post(() -> {
            try {
                setCharacteristics();
                sendState();
            } catch (Exception e) {
                fail(e);
            }
        });
    }

    void setPreview(SurfaceTexture value) {
        worker.post(() -> {
            if (texture == value) return;
            texture = value;
            if (enabled && camera != null) configureSession(true);
        });
    }

    void refreshPreview() { worker.post(this::sendPreview); }

    void rotation(int degrees) {
        worker.post(() -> {
            if (displayRotation == degrees) return;
            displayRotation = degrees;
            if (encoder != null && parameterSets.length > 0) {
                sendConfiguration();
                keyframe();
            }
            sendPreview();
        });
    }

    void start() {
        worker.post(() -> {
            enabled = true;
            if (camera == null) reopen();
        });
    }

    void stop() {
        worker.post(() -> {
            enabled = false;
            release();
        });
    }

    void change(JSONObject command) {
        worker.post(() -> {
            boolean wantedFront = command.optBoolean("front", front);
            if ((wantedFront ? frontId : rearId) == null) wantedFront = front;
            int wantedHeight = command.optInt("height", height);
            if (wantedHeight != 360 && wantedHeight != 480 && wantedHeight != 720 && wantedHeight != 1080) wantedHeight = height;
            int wantedFps = command.optInt("fps", fps);
            if (wantedFps != 24 && wantedFps != 30 && wantedFps != 60) wantedFps = fps;
            boolean rebuild = wantedFront != front || wantedHeight != height || wantedFps != fps;
            front = wantedFront;
            height = wantedHeight;
            fps = wantedFps;
            cameraFps = chooseFps(characteristics == null ? null : characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES), fps);
            zoom = command.optInt("zoom", zoom);
            ev = command.optInt("ev", ev);
            wb = command.optInt("wb", wb);
            manualExposure = command.optBoolean("manualExposure", manualExposure);
            shutter = command.optInt("shutter", shutter);
            iso = command.optInt("iso", iso);
            manualFocus = command.optBoolean("manualFocus", manualFocus);
            focus = command.optInt("focus", focus);
            try {
                setCharacteristics();
                clampSettings();
                if ((rebuild || camera == null && encoder == null) && enabled) reopen();
                else applySettings();
                sendState();
            } catch (Exception e) {
                fail(e);
            }
        });
    }

    void snapshot() {
        worker.post(() -> {
            sendState();
            if (configuration != null) listener.configuration(configuration);
            keyframe();
        });
    }

    void requestKeyframe() {
        worker.post(this::keyframe);
    }

    private void keyframe() {
        if (encoder == null) return;
        try {
            Bundle params = new Bundle();
            params.putInt(MediaCodec.PARAMETER_KEY_REQUEST_SYNC_FRAME, 0);
            encoder.setParameters(params);
        } catch (IllegalStateException ignored) {}
    }

    private void setCharacteristics() throws CameraAccessException {
        String id = front ? frontId : rearId;
        if (id == null) throw new IllegalStateException("Камера не обнаружена");
        characteristics = manager.getCameraCharacteristics(id);
    }

    @SuppressWarnings("MissingPermission")
    private void reopen() {
        release();
        try {
            setCharacteristics();
            clampSettings();
            selectFormat();
            createEncoder();
            int token = generation;
            sendPreview();
            sendState();
            manager.openCamera(front ? frontId : rearId, new CameraDevice.StateCallback() {
                @Override public void onOpened(CameraDevice opened) {
                    if (token != generation) {
                        opened.close();
                        return;
                    }
                    camera = opened;
                    configureSession(true);
                }
                @Override public void onDisconnected(CameraDevice device) {
                    device.close();
                    if (token == generation) fail(new IllegalStateException("Камера отключилась"));
                }
                @Override public void onError(CameraDevice device, int error) {
                    device.close();
                    if (token == generation) fail(new IllegalStateException("Камера недоступна (код " + error + ")"));
                }
            }, worker);
        } catch (Exception e) {
            fail(e);
        }
    }

    private void configureSession(boolean allowPreview) {
        int token = ++sessionGeneration;
        if (session != null) { session.close(); session = null; }
        if (preview != null) { preview.release(); preview = null; }
        capture = null;
        try {
            if (allowPreview && texture != null && !texture.isReleased()) {
                texture.setDefaultBufferSize(size.getWidth(), size.getHeight());
                preview = new Surface(texture);
            }
            boolean withPreview = preview != null;
            CaptureRequest.Builder request = camera.createCaptureRequest(CameraDevice.TEMPLATE_RECORD);
            request.addTarget(encoderSurface);
            if (withPreview) request.addTarget(preview);
            java.util.List<Surface> targets = withPreview ? Arrays.asList(encoderSurface, preview)
                : java.util.Collections.singletonList(encoderSurface);
            camera.createCaptureSession(targets, new CameraCaptureSession.StateCallback() {
                @Override public void onConfigured(CameraCaptureSession ready) {
                    if (token != sessionGeneration) { ready.close(); return; }
                    session = ready;
                    capture = request;
                    try {
                        applySettings();
                        keyframe();
                    } catch (CameraAccessException | IllegalStateException failure) {
                        if (withPreview) configureSession(false);
                        else fail(failure);
                    }
                }
                @Override public void onConfigureFailed(CameraCaptureSession failed) {
                    failed.close();
                    if (token != sessionGeneration) return;
                    if (withPreview) configureSession(false);
                    else fail(new IllegalStateException("Выберите другое разрешение или FPS"));
                }
            }, worker);
        } catch (CameraAccessException | IllegalArgumentException | IllegalStateException failure) {
            if (allowPreview && texture != null) configureSession(false);
            else fail(failure);
        }
    }

    private void selectFormat() {
        StreamConfigurationMap map = characteristics.get(CameraCharacteristics.SCALER_STREAM_CONFIGURATION_MAP);
        Size[] outputs = map == null ? null : map.getOutputSizes(MediaCodec.class);
        if (outputs == null || outputs.length == 0) throw new IllegalStateException("Камера не сообщает режимы записи");
        Range<Integer>[] ranges = characteristics.get(CameraCharacteristics.CONTROL_AE_AVAILABLE_TARGET_FPS_RANGES);
        MediaCodecInfo[] codecs = new MediaCodecList(MediaCodecList.REGULAR_CODECS).getCodecInfos();
        Size[] previewSizes = map.getOutputSizes(SurfaceTexture.class);
        if (Build.VERSION.SDK_INT >= 29) {
            Arrays.sort(codecs, Comparator.comparing(info -> !info.isHardwareAccelerated()));
        }
        Size[] ordered = Arrays.stream(outputs)
            .filter(s -> previewSizes == null || Arrays.asList(previewSizes).contains(s))
            .filter(s -> s.getWidth() <= 1920 && s.getHeight() <= 1080)
            .sorted(Comparator.comparingDouble(s -> Math.abs(s.getHeight() - height)
                + Math.abs(s.getWidth() / (double) s.getHeight() - 16d / 9) * 350
                + (s.getHeight() > height ? 200 : 0)))
            .toArray(Size[]::new);
        // Keep the selected resolution when the normal camera session has a lower frame rate.
        for (Size candidate : ordered) {
            long minDuration = map.getOutputMinFrameDuration(MediaCodec.class, candidate);
            int limit = minDuration > 0 ? (int) Math.round(1e9 / minDuration) : 60;
            int requested = Math.max(1, Math.min(fps, limit));
            for (MediaCodecInfo info : codecs) {
                if (!info.isEncoder()) continue;
                try {
                    var capability = info.getCapabilitiesForType(MediaFormat.MIMETYPE_VIDEO_AVC);
                    if (Arrays.stream(capability.colorFormats).noneMatch(color ->
                        color == MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)) continue;
                    var video = capability.getVideoCapabilities();
                    if (!video.isSizeSupported(candidate.getWidth(), candidate.getHeight())) continue;
                    int encoderLimit = (int) Math.floor(video.getSupportedFrameRatesFor(candidate.getWidth(), candidate.getHeight()).getUpper());
                    Range<Integer> range = chooseFps(ranges, Math.min(requested, encoderLimit));
                    if (range.getUpper() > limit + 1 || range.getUpper() > encoderLimit) continue;
                    size = candidate;
                    cameraFps = range;
                    actualFps = range.getUpper();
                    codecName = info.getName();
                    return;
                } catch (IllegalArgumentException ignored) {}
            }
        }
        throw new IllegalStateException("Подходящий режим H.264 не найден");
    }

    private static Range<Integer> chooseFps(Range<Integer>[] ranges, int requested) {
        if (ranges == null || ranges.length == 0) return new Range<>(requested, requested);
        return Arrays.stream(ranges).min(Comparator.comparingInt(r -> {
            int upper = r.getUpper();
            int gap = Math.abs(upper - requested);
            return gap * 100 + (upper > requested ? 80 : 0) + upper - r.getLower();
        })).orElse(new Range<>(requested, requested));
    }

    private void createEncoder() throws Exception {
        int width = size.getWidth();
        int outputHeight = size.getHeight();
        int roundedFps = (int) actualFps;
        MediaFormat format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, outputHeight);
        format.setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);
        format.setInteger(MediaFormat.KEY_BIT_RATE, Math.max(750_000, Math.min(15_000_000, (int) (width * outputHeight * actualFps * 0.14))));
        format.setInteger(MediaFormat.KEY_FRAME_RATE, roundedFps);
        format.setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1);
        format.setInteger(MediaFormat.KEY_PRIORITY, 0);
        if (Build.VERSION.SDK_INT >= 29) format.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);

        encoder = MediaCodec.createByCodecName(codecName);
        MediaCodec active = encoder;
        active.setCallback(new MediaCodec.Callback() {
            @Override public void onInputBufferAvailable(MediaCodec codec, int index) {}
            @Override public void onOutputBufferAvailable(MediaCodec codec, int index, MediaCodec.BufferInfo info) {
                if (codec != encoder) return;
                try {
                    if (info.size <= 0 || (info.flags & MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0) return;
                    boolean key = (info.flags & MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0;
                    if (configuration == null || (needsKey && !key)) return;
                    ByteBuffer output = codec.getOutputBuffer(index);
                    if (output == null) return;
                    byte[] nal = new byte[info.size];
                    output.position(info.offset);
                    output.limit(info.offset + info.size);
                    output.get(nal);
                    nal = annexB(nal);
                    if (key) {
                        needsKey = false;
                        byte[] accessUnit = Arrays.copyOf(parameterSets, parameterSets.length + nal.length);
                        System.arraycopy(nal, 0, accessUnit, parameterSets.length, nal.length);
                        nal = accessUnit;
                    }
                    listener.packet(new Wire.Packet(key ? Wire.KEY : Wire.DELTA, info.presentationTimeUs, nal));
                } finally {
                    codec.releaseOutputBuffer(index, false);
                }
            }
            @Override public void onError(MediaCodec codec, MediaCodec.CodecException error) {
                if (codec == encoder) fail(error);
            }
            @Override public void onOutputFormatChanged(MediaCodec codec, MediaFormat output) {
                if (codec != encoder) return;
                var headers = new ByteArrayOutputStream();
                for (String key : new String[]{"csd-0", "csd-1"}) {
                    ByteBuffer data = output.getByteBuffer(key);
                    if (data == null) continue;
                    data = data.duplicate();
                    byte[] bytes = new byte[data.remaining()];
                    data.get(bytes);
                    byte[] annex = annexB(bytes);
                    headers.write(annex, 0, annex.length);
                }
                parameterSets = headers.toByteArray();
                sendConfiguration();
                keyframe();
            }
        }, worker);
        active.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE);
        encoderSurface = active.createInputSurface();
        active.start();
    }

    static byte[] annexB(byte[] bytes) {
        if (bytes.length >= 4 && bytes[0] == 0 && bytes[1] == 0
            && (bytes[2] == 1 || (bytes[2] == 0 && bytes[3] == 1))) return bytes;
        byte[] normalized = bytes.clone();
        int start = 0;
        while (start + 4 < bytes.length) {
            long length = ((bytes[start] & 255L) << 24) | ((bytes[start + 1] & 255L) << 16)
                | ((bytes[start + 2] & 255L) << 8) | (bytes[start + 3] & 255L);
            if (length == 0 || length > bytes.length - start - 4) break;
            Arrays.fill(normalized, start, start + 3, (byte) 0);
            normalized[start + 3] = 1;
            start += 4 + (int) length;
        }
        if (start == bytes.length) return normalized;
        byte[] result = new byte[bytes.length + 4];
        result[3] = 1;
        System.arraycopy(bytes, 0, result, 4, bytes.length);
        return result;
    }

    private String avcCodec() {
        for (int i = 2; i + 4 < parameterSets.length; i++) {
            if (parameterSets[i] != 1 || parameterSets[i - 1] != 0 || parameterSets[i - 2] != 0) continue;
            if ((parameterSets[i + 1] & 31) != 7) continue;
            return String.format(Locale.ROOT, "avc1.%02x%02x%02x", parameterSets[i + 2] & 255,
                parameterSets[i + 3] & 255, parameterSets[i + 4] & 255);
        }
        return "avc1.420028";
    }

    private void sendConfiguration() {
        needsKey = true;
        JSONObject config = Wire.json("video");
        Wire.put(config, "codec", avcCodec());
        Wire.put(config, "width", size.getWidth());
        Wire.put(config, "height", size.getHeight());
        Wire.put(config, "rotation", rotation());
        Wire.put(config, "front", front);
        Wire.put(config, "fps", (int) actualFps);
        configuration = config;
        listener.configuration(config);
    }

    private int rotation() {
        Integer sensor = characteristics == null ? null : characteristics.get(CameraCharacteristics.SENSOR_ORIENTATION);
        return ((sensor == null ? 0 : sensor) + (front ? displayRotation : -displayRotation) + 360) % 360;
    }

    private void sendPreview() {
        listener.preview(size.getWidth(), size.getHeight(), rotation(), front);
    }

    private void clampSettings() {
        zoom = Math.max(100, Math.min(zoom, zoomMax()));
        ev = evRange().clamp(ev);
        if (!Arrays.stream(whiteBalances()).anyMatch(mode -> mode == wb)) wb = CaptureRequest.CONTROL_AWB_MODE_AUTO;
        manualExposure &= allowsManual();
        manualFocus &= focusMax() > 0;
        focus = Math.max(0, Math.min(100, focus));
        shutter = exposureRange().clamp(shutter);
        iso = isoRange().clamp(iso);
    }

    private void applySettings() throws CameraAccessException {
        if (session == null || capture == null) return;
        if (Build.VERSION.SDK_INT >= 31) {
            int[] modes = characteristics.get(CameraCharacteristics.SCALER_AVAILABLE_ROTATE_AND_CROP_MODES);
            if (modes != null && Arrays.stream(modes).anyMatch(mode -> mode == CaptureRequest.SCALER_ROTATE_AND_CROP_NONE))
                capture.set(CaptureRequest.SCALER_ROTATE_AND_CROP, CaptureRequest.SCALER_ROTATE_AND_CROP_NONE);
        }
        capture.set(CaptureRequest.CONTROL_MODE, CaptureRequest.CONTROL_MODE_AUTO);
        capture.set(CaptureRequest.CONTROL_AE_TARGET_FPS_RANGE, cameraFps);
        capture.set(CaptureRequest.CONTROL_AWB_MODE, wb);
        capture.set(CaptureRequest.CONTROL_AE_MODE, manualExposure ? CaptureRequest.CONTROL_AE_MODE_OFF : CaptureRequest.CONTROL_AE_MODE_ON);
        if (manualExposure) {
            long exposureNs = Math.min(shutter * 1000L, (long) (1e9 / actualFps));
            capture.set(CaptureRequest.SENSOR_EXPOSURE_TIME, exposureNs);
            capture.set(CaptureRequest.SENSOR_SENSITIVITY, iso);
            capture.set(CaptureRequest.SENSOR_FRAME_DURATION, (long) (1e9 / actualFps));
        } else {
            capture.set(CaptureRequest.SENSOR_EXPOSURE_TIME, null);
            capture.set(CaptureRequest.SENSOR_SENSITIVITY, null);
            capture.set(CaptureRequest.SENSOR_FRAME_DURATION, null);
            capture.set(CaptureRequest.CONTROL_AE_EXPOSURE_COMPENSATION, ev);
        }
        int[] af = characteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
        int mode = CaptureRequest.CONTROL_AF_MODE_OFF;
        if (!manualFocus && af != null) {
            if (Arrays.stream(af).anyMatch(x -> x == CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO))
                mode = CaptureRequest.CONTROL_AF_MODE_CONTINUOUS_VIDEO;
            else if (Arrays.stream(af).anyMatch(x -> x == CaptureRequest.CONTROL_AF_MODE_AUTO))
                mode = CaptureRequest.CONTROL_AF_MODE_AUTO;
        }
        capture.set(CaptureRequest.CONTROL_AF_MODE, mode);
        if (manualFocus) capture.set(CaptureRequest.LENS_FOCUS_DISTANCE, focusMax() * focus / 100f);
        else capture.set(CaptureRequest.LENS_FOCUS_DISTANCE, null);

        Range<Float> zoomRatio = Build.VERSION.SDK_INT >= 30
            ? characteristics.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE) : null;
        if (Build.VERSION.SDK_INT >= 30 && zoomRatio != null) {
            capture.set(CaptureRequest.CONTROL_ZOOM_RATIO, zoomRatio.clamp(zoom / 100f));
        } else {
            var rect = characteristics.get(CameraCharacteristics.SENSOR_INFO_ACTIVE_ARRAY_SIZE);
            if (rect != null) {
                int w = Math.min(rect.width(), Math.max(2, rect.width() * 100 / zoom));
                int h = Math.min(rect.height(), Math.max(2, rect.height() * 100 / zoom));
                int left = rect.left + (rect.width() - w) / 2;
                int top = rect.top + (rect.height() - h) / 2;
                capture.set(CaptureRequest.SCALER_CROP_REGION, new android.graphics.Rect(left, top, left + w, top + h));
            }
        }
        session.setRepeatingRequest(capture.build(), null, worker);
    }

    private int zoomMax() {
        if (characteristics == null) return 100;
        Range<Float> range = Build.VERSION.SDK_INT >= 30
            ? characteristics.get(CameraCharacteristics.CONTROL_ZOOM_RATIO_RANGE) : null;
        Float max = range == null ? characteristics.get(CameraCharacteristics.SCALER_AVAILABLE_MAX_DIGITAL_ZOOM) : range.getUpper();
        return max == null ? 100 : Math.max(100, Math.round(max * 100));
    }

    private Range<Integer> evRange() {
        Range<Integer> range = characteristics == null ? null : characteristics.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_RANGE);
        return range == null ? new Range<>(0, 0) : range;
    }

    private int[] whiteBalances() {
        int[] values = characteristics == null ? null : characteristics.get(CameraCharacteristics.CONTROL_AWB_AVAILABLE_MODES);
        if (values == null) return new int[] { CaptureRequest.CONTROL_AWB_MODE_AUTO };
        return Arrays.stream(values).filter(x -> x >= 1 && x <= 8).toArray();
    }

    private boolean allowsManual() {
        int[] caps = characteristics == null ? null : characteristics.get(CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES);
        return caps != null && Arrays.stream(caps).anyMatch(x -> x == CameraCharacteristics.REQUEST_AVAILABLE_CAPABILITIES_MANUAL_SENSOR);
    }

    private Range<Integer> exposureRange() {
        Range<Long> range = characteristics == null ? null : characteristics.get(CameraCharacteristics.SENSOR_INFO_EXPOSURE_TIME_RANGE);
        if (range == null) return new Range<>(100, 30000);
        int min = (int) Math.max(1, (range.getLower() + 999) / 1000);
        int max = Math.max(min, (int) Math.min(range.getUpper() / 1000, 1e6 / actualFps));
        return new Range<>(min, max);
    }

    private Range<Integer> isoRange() {
        Range<Integer> range = characteristics == null ? null : characteristics.get(CameraCharacteristics.SENSOR_INFO_SENSITIVITY_RANGE);
        return range == null ? new Range<>(100, 1600) : range;
    }

    private float focusMax() {
        Float max = characteristics == null ? null : characteristics.get(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
        if (max == null) return 0;
        int[] modes = characteristics.get(CameraCharacteristics.CONTROL_AF_AVAILABLE_MODES);
        return modes != null && Arrays.stream(modes).anyMatch(mode -> mode == CaptureRequest.CONTROL_AF_MODE_OFF) ? max : 0;
    }

    private void sendState() {
        JSONObject state = Wire.json("settings");
        Wire.put(state, "front", front);
        Wire.put(state, "hasRear", rearId != null);
        Wire.put(state, "hasFront", frontId != null);
        Wire.put(state, "height", height);
        Wire.put(state, "fps", fps);
        Wire.put(state, "actualWidth", size.getWidth());
        Wire.put(state, "actualHeight", size.getHeight());
        Wire.put(state, "actualFps", (int) actualFps);
        Wire.put(state, "zoom", zoom);
        Wire.put(state, "zoomMax", zoomMax());
        Wire.put(state, "ev", ev);
        Wire.put(state, "evMin", evRange().getLower());
        Wire.put(state, "evMax", evRange().getUpper());
        var evStep = characteristics == null ? null : characteristics.get(CameraCharacteristics.CONTROL_AE_COMPENSATION_STEP);
        Wire.put(state, "evStep", evStep == null ? 0.0 : evStep.doubleValue());
        Wire.put(state, "wb", wb);
        var whiteBalances = new JSONArray();
        for (int mode : whiteBalances()) whiteBalances.put(mode);
        Wire.put(state, "whiteBalances", whiteBalances);
        Wire.put(state, "hasManualExposure", allowsManual());
        Wire.put(state, "manualExposure", manualExposure);
        Wire.put(state, "shutter", shutter);
        Wire.put(state, "shutterMin", exposureRange().getLower());
        Wire.put(state, "shutterMax", exposureRange().getUpper());
        Wire.put(state, "iso", iso);
        Wire.put(state, "isoMin", isoRange().getLower());
        Wire.put(state, "isoMax", isoRange().getUpper());
        Wire.put(state, "hasManualFocus", focusMax() > 0);
        Wire.put(state, "manualFocus", manualFocus);
        Wire.put(state, "focus", focus);
        listener.state(state);
    }

    private void fail(Exception error) {
        release();
        listener.failed(error.getLocalizedMessage() == null ? error.getClass().getSimpleName() : error.getLocalizedMessage());
    }

    private void release() {
        generation++;
        sessionGeneration++;
        if (session != null) { session.close(); session = null; }
        if (camera != null) { camera.close(); camera = null; }
        capture = null;
        if (encoder != null) { encoder.release(); encoder = null; }
        if (encoderSurface != null) { encoderSurface.release(); encoderSurface = null; }
        if (preview != null) { preview.release(); preview = null; }
        configuration = null;
        parameterSets = new byte[0];
        needsKey = true;
    }

    @Override public void close() {
        worker.post(() -> {
            enabled = false;
            release();
            thread.quitSafely();
        });
    }
}
