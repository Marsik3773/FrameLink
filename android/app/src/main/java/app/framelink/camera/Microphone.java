package app.framelink.camera;

import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.os.Process;
import java.util.function.Consumer;

final class Microphone {
    private static final int SAMPLE_RATE = 48000;
    private final Consumer<Wire.Packet> send;
    private final Consumer<String> failed;
    private Capture capture;

    Microphone(Consumer<Wire.Packet> send, Consumer<String> failed) {
        this.send = send;
        this.failed = failed;
    }

    @SuppressWarnings("MissingPermission")
    synchronized boolean start() {
        if (capture != null) return true;
        AudioRecord record = null;
        try {
            int buffer = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            if (buffer <= 0) throw new IllegalStateException("Микрофон не поддерживает 48 кГц");
            record = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, SAMPLE_RATE,
                AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(buffer, 7680));
            record.startRecording();
            if (record.getRecordingState() != AudioRecord.RECORDSTATE_RECORDING) {
                throw new IllegalStateException("Микрофон недоступен");
            }
            capture = new Capture(record);
            new Thread(capture, "FrameLink microphone").start();
            return true;
        } catch (RuntimeException e) {
            if (record != null) record.release();
            failed.accept(e.getMessage() == null ? "Микрофон недоступен" : e.getMessage());
            return false;
        }
    }

    synchronized void stop() {
        if (capture == null) return;
        capture.running = false;
        try { capture.record.stop(); } catch (IllegalStateException ignored) {}
        capture = null;
    }

    private final class Capture implements Runnable {
        final AudioRecord record;
        volatile boolean running = true;

        Capture(AudioRecord record) {
            this.record = record;
        }

        @Override public void run() {
            try {
                Process.setThreadPriority(Process.THREAD_PRIORITY_AUDIO);
                while (running) {
                    byte[] frame = new byte[1920];
                    int size = record.read(frame, 0, frame.length, AudioRecord.READ_BLOCKING);
                    if (!running) break;
                    if (size < 0) throw new IllegalStateException("Запись микрофона прервалась");
                    if (size > 0) send.accept(new Wire.Packet(Wire.PCM, System.nanoTime() / 1000,
                        size == frame.length ? frame : java.util.Arrays.copyOf(frame, size)));
                }
            } catch (RuntimeException e) {
                if (running) failed.accept("Запись микрофона прервалась");
            } finally {
                synchronized (Microphone.this) {
                    if (capture == this) capture = null;
                    record.release();
                }
            }
        }
    }
}
