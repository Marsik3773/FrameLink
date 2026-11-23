package app.framelink.camera;

import android.Manifest;
import android.app.*;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.pm.ServiceInfo;
import android.graphics.SurfaceTexture;
import android.os.*;
import android.util.Log;
import org.json.JSONObject;
import java.net.Inet4Address;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public final class StreamService extends Service {
    static final String START = "app.framelink.camera.START";
    static final String STOP = "app.framelink.camera.STOP";
    private static final String CHANNEL = "camera";
    private static final int NOTICE = 4747;

    interface Listener {
        void changed();
        void settings(JSONObject state);
        void preview(int width, int height, int rotation, boolean front);
    }

    final class LocalBinder extends Binder {
        StreamService service() { return StreamService.this; }
    }

    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService network = Executors.newSingleThreadExecutor();
    private final LocalBinder binder = new LocalBinder();
    private CameraEngine camera;
    private Microphone microphone;
    private volatile LinkServer server;
    private Discovery discovery;
    private Listener listener;
    private PowerManager.WakeLock wake;
    private JSONObject cameraSettings, video;
    private int generation;
    int port = 4747;
    boolean starting, available, connected, micEnabled;
    String error = "";
    private boolean micActive;

    @Override public void onCreate() {
        super.onCreate();
        var manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "FrameLink", NotificationManager.IMPORTANCE_LOW));
        wake = getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "FrameLink:video");
        microphone = new Microphone(this::send, message -> ui.post(() -> {
            micActive = false;
            publishAudio();
        }));
        camera = new CameraEngine(this, new CameraEngine.Listener() {
            @Override public void packet(Wire.Packet packet) { send(packet); }
            @Override public void configuration(JSONObject config) {
                LinkServer current = server;
                if (current != null) current.resetVideo(config);
                ui.post(() -> {
                    if (!connected) return;
                    video = config;
                    error = "";
                    changed();
                });
            }
            @Override public void state(JSONObject settings) {
                send(Wire.json(settings));
                ui.post(() -> {
                    cameraSettings = settings;
                    if (listener != null) listener.settings(settings);
                });
            }
            @Override public void preview(int width, int height, int rotation, boolean front) {
                ui.post(() -> {
                    if (listener != null) listener.preview(width, height, rotation, front);
                });
            }
            @Override public void failed(String message) {
                ui.post(() -> {
                    if (!connected) return;
                    error = message;
                    JSONObject event = Wire.json("cameraError");
                    Wire.put(event, "message", message);
                    send(Wire.json(event));
                    changed();
                });
            }
        });
    }

    @Override public IBinder onBind(Intent intent) { return binder; }

    @Override public int onStartCommand(Intent intent, int flags, int id) {
        if (intent == null || STOP.equals(intent.getAction())) {
            stopAccess();
            return START_NOT_STICKY;
        }
        if (!START.equals(intent.getAction()) || available || starting) return START_NOT_STICKY;
        port = intent.getIntExtra("port", 4747);
        micEnabled = intent.getBooleanExtra("mic", false);
        starting = true;
        error = "";
        try {
            promote();
            openServer(++generation, port);
        } catch (RuntimeException failure) {
            stopAccess();
            error = "Разрешите доступ к камере";
        }
        changed();
        return START_NOT_STICKY;
    }

    void observe(Listener next) {
        listener = next;
        if (next == null) return;
        next.changed();
        if (cameraSettings != null) next.settings(cameraSettings);
        camera.refreshPreview();
    }

    void preview(SurfaceTexture texture) { camera.setPreview(texture); }
    void rotation(int degrees) { camera.rotation(degrees); }
    void settings(JSONObject changes) { camera.change(changes); }
    JSONObject video() { return video; }

    void microphone(boolean enabled) {
        micEnabled = enabled;
        if (available || starting) {
            try { promote(); } catch (RuntimeException ignored) {}
        }
        updateMic();
        changed();
    }

    private void openServer(int token, int requestedPort) {
        network.execute(() -> {
            try {
                LinkServer next = new LinkServer(requestedPort, new ServerIdentity(), new LinkServer.Listener() {
                    @Override public void connected(boolean value) {
                        ui.post(() -> {
                            if (generation != token || !available) return;
                            connected = value;
                            error = "";
                            video = null;
                            if (value) {
                                if (!wake.isHeld()) wake.acquire();
                                camera.start();
                                camera.snapshot();
                            } else {
                                camera.stop();
                                if (wake.isHeld()) wake.release();
                            }
                            updateMic();
                            updateNotification();
                            changed();
                        });
                    }
                    @Override public void command(JSONObject command) {
                        ui.post(() -> {
                            if (generation != token || !connected) return;
                            switch (command.optString("type")) {
                                case "settings" -> camera.change(command);
                                case "keyframe" -> camera.requestKeyframe();
                            }
                        });
                    }
                    @Override public void requestKeyframe() { camera.requestKeyframe(); }
                    @Override public void failed(String message) { ui.post(() -> fail(token, message)); }
                });
                ui.post(() -> {
                    if (generation != token || !starting) {
                        next.close();
                        return;
                    }
                    server = next;
                    starting = false;
                    available = true;
                    next.start();
                    try { discovery = new Discovery(this, requestedPort, next::busy); }
                    catch (Exception failure) { Log.d("FrameLink", "LAN discovery unavailable", failure); }
                    updateNotification();
                    changed();
                });
            } catch (Exception failure) {
                ui.post(() -> fail(token, "Порт недоступен"));
            }
        });
    }

    private void fail(int token, String message) {
        if (generation != token) return;
        stopAccess();
        error = message;
        changed();
    }

    private void send(Wire.Packet packet) {
        LinkServer current = server;
        if (current != null) current.send(packet);
    }

    private void updateMic() {
        micActive = connected && micEnabled && microphone.start();
        if (!micActive) microphone.stop();
        publishAudio();
    }

    private void publishAudio() {
        JSONObject event = Wire.json("audio");
        Wire.put(event, "active", micActive);
        send(Wire.json(event));
    }

    private void promote() {
        Notification notice = notification();
        if (Build.VERSION.SDK_INT >= 30) {
            int types = ServiceInfo.FOREGROUND_SERVICE_TYPE_CAMERA;
            if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
                types |= ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE;
            startForeground(NOTICE, notice, types);
        } else startForeground(NOTICE, notice);
    }

    private Notification notification() {
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class)
            .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP), flags);
        PendingIntent stop = PendingIntent.getService(this, 1, new Intent(this, StreamService.class).setAction(STOP), flags);
        return new Notification.Builder(this, CHANNEL).setSmallIcon(R.drawable.ic_camera)
            .setContentTitle("FrameLink").setContentText(connected ? "Камера подключена" : "Доступна для подключения")
            .setContentIntent(open).setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "Остановить", stop).build()).build();
    }

    private void updateNotification() {
        getSystemService(NotificationManager.class).notify(NOTICE, notification());
    }

    void stopAccess() {
        closeTransport();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        changed();
    }

    private void closeTransport() {
        ++generation;
        available = starting = connected = false;
        video = null;
        error = "";
        camera.stop();
        if (wake.isHeld()) wake.release();
        updateMic();
        LinkServer old = server;
        server = null;
        if (discovery != null) { discovery.close(); discovery = null; }
        if (old != null) network.execute(old::close);
    }

    private void changed() {
        if (listener != null) listener.changed();
    }

    static String endpoints(int port) {
        var addresses = new LinkedHashSet<String>();
        try {
            for (NetworkInterface iface : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!iface.isUp() || iface.isLoopback()) continue;
                for (var ip : Collections.list(iface.getInetAddresses())) {
                    if (ip instanceof Inet4Address && Discovery.local(ip)) addresses.add(ip.getHostAddress() + ":" + port);
                }
            }
        } catch (Exception ignored) {}
        return addresses.isEmpty() ? "Порт " + port : String.join("\n", addresses);
    }

    @Override public void onDestroy() {
        closeTransport();
        camera.close();
        network.shutdown();
        super.onDestroy();
    }
}
