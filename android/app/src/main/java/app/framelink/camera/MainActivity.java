package app.framelink.camera;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.content.pm.PackageManager;
import android.graphics.Matrix;
import android.graphics.SurfaceTexture;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.Surface;
import android.view.TextureView;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.net.Inet4Address;
import java.net.NetworkInterface;
import java.util.Arrays;
import java.util.Collections;
import java.util.LinkedHashSet;
import java.util.function.IntConsumer;

public final class MainActivity extends Activity {
    private static final int BG = 0xff101315, PANEL = 0xff191e20, INK = 0xffedf3f1;
    private static final int MUTED = 0xffa7b5b0, MINT = 0xffa5e9d2;
    private static final String[] BALANCES = {"", "Авто", "Лампа накаливания", "Люминесцентный", "Тёплый люминесцентный",
        "Дневной свет", "Облачность", "Сумерки", "Тень"};
    private final Handler ui = new Handler(Looper.getMainLooper());
    private CameraEngine camera;
    private JSONObject pendingSettings = new JSONObject();
    private boolean localSettingsScheduled;
    private final Runnable sendLocalSettings = () -> {
        localSettingsScheduled = false;
        JSONObject changes = pendingSettings;
        pendingSettings = new JSONObject();
        camera.change(changes);
    };
    private Microphone mic;
    private volatile LinkServer server;
    private boolean foreground, connecting, connected, micEnabled, micActive, updating;
    private int epoch, bufferWidth = 1280, bufferHeight = 720, bufferRotation;
    private int[] cameraChoices = {0, 1}, wbChoices = {1};
    private boolean mirrorPreview;
    private String lastCameraError;
    private final Runnable refreshEndpoints = new Runnable() {
        @Override public void run() {
            if (server == null) return;
            address.setText(endpoints(Integer.parseInt(port.getText().toString())));
            ui.postDelayed(this, 3500);
        }
    };
    private TextureView preview;
    private FrameLayout previewFrame;
    private EditText port;
    private TextView status, address, pairCode, format, cameraError, micStatus;
    private Button start;
    private Switch micToggle, exposureToggle, focusToggle;
    private Spinner lens, resolution, fps, wb;
    private Slider zoom, exposure, shutter, iso, focus;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        makeUi();
        camera = new CameraEngine(this, new CameraEngine.Listener() {
            @Override public void packet(Wire.Packet packet) { send(packet); }
            @Override public void configuration(JSONObject config) {
                LinkServer active = server;
                if (active != null) active.resetVideo(config);
                runOnUiThread(() -> {
                    lastCameraError = null;
                    cameraError.setVisibility(View.GONE);
                    int width = config.optInt("width");
                    int height = config.optInt("height");
                    if (config.optInt("rotation") % 180 != 0) { int swap = width; width = height; height = swap; }
                    format.setText(width + " × " + height + "   ·   " + config.optInt("fps") + " FPS");
                });
            }
            @Override public void state(JSONObject settings) {
                send(Wire.json(settings));
                runOnUiThread(() -> sync(settings));
            }
            @Override public void preview(int width, int height, int rotation, boolean front) {
                runOnUiThread(() -> {
                    bufferWidth = width;
                    bufferHeight = height;
                    bufferRotation = rotation;
                    mirrorPreview = front;
                    layoutPreview();
                });
            }
            @Override public void failed(String error) { runOnUiThread(() -> reportCamera(error)); }
        });
        mic = new Microphone(this::send, error -> runOnUiThread(() -> {
            micActive = false;
            micStatus.setText(error);
            publishAudioState();
        }));
        preview.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture texture, int w, int h) {
                camera.setPreview(texture);
                if (foreground && hasCameraPermission()) camera.start();
            }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int w, int h) { layoutPreview(); }
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) {
                camera.setPreview(null);
                return true;
            }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture texture) {}
        });
        if (preview.isAvailable()) camera.setPreview(preview.getSurfaceTexture());
        if (!hasCameraPermission()) requestPermissions(new String[]{Manifest.permission.CAMERA}, 1);
    }

    @Override protected void onResume() {
        super.onResume();
        foreground = true;
        updateRotation();
        if (hasCameraPermission() && preview.isAvailable()) camera.start();
    }

    @Override protected void onStop() {
        foreground = false;
        stopLink();
        camera.stop();
        super.onStop();
    }

    @Override protected void onDestroy() {
        ui.removeCallbacks(sendLocalSettings);
        camera.close();
        super.onDestroy();
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        updateRotation();
        layoutPreview();
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        boolean granted = results.length > 0 && results[0] == PackageManager.PERMISSION_GRANTED;
        if (request == 1) {
            if (granted && foreground) camera.start();
            else if (!granted) reportCamera("Разрешите доступ к камере, чтобы начать трансляцию");
        }
        if (request == 2) {
            micEnabled = granted;
            updating = true;
            micToggle.setChecked(granted);
            updating = false;
            updateMicrophone();
        }
    }

    private boolean hasCameraPermission() {
        return checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED;
    }

    private void updateRotation() {
        int rotation = getWindowManager().getDefaultDisplay().getRotation();
        camera.rotation(rotation == Surface.ROTATION_90 ? 90 : rotation == Surface.ROTATION_180 ? 180
            : rotation == Surface.ROTATION_270 ? 270 : 0);
    }

    private void startLink() {
        if (!hasCameraPermission()) {
            requestPermissions(new String[]{Manifest.permission.CAMERA}, 1);
            return;
        }
        int requestedPort;
        try {
            requestedPort = Integer.parseInt(port.getText().toString());
            if (requestedPort < 1024 || requestedPort > 65535) throw new NumberFormatException();
        } catch (NumberFormatException error) {
            port.setError("Порт от 1024 до 65535");
            return;
        }
        getPreferences(MODE_PRIVATE).edit().putInt("port", requestedPort).apply();
        int session = ++epoch;
        connecting = true;
        port.setEnabled(false);
        start.setText("Отменить");
        status.setText("Запуск…");
        camera.start();
        new Thread(() -> {
            try {
                Pairing pairing = new Pairing();
                LinkServer next = new LinkServer(requestedPort, pairing, new LinkServer.Listener() {
                    @Override public void connected(boolean value) {
                        runOnUiThread(() -> {
                            if (session != epoch) return;
                            connected = value;
                            status.setText(value ? "Подключено" : "Ожидание компьютера");
                            status.setTextColor(value ? MINT : MUTED);
                            if (value) {
                                camera.snapshot();
                                if (lastCameraError != null) reportCamera(lastCameraError);
                            }
                            updateMicrophone();
                        });
                    }
                    @Override public void command(JSONObject command) {
                        runOnUiThread(() -> {
                            if (session != epoch) return;
                            switch (command.optString("type")) {
                                case "settings" -> camera.change(command);
                                case "keyframe" -> camera.requestKeyframe();
                            }
                        });
                    }
                    @Override public void requestKeyframe() { camera.requestKeyframe(); }
                    @Override public void failed(String error) {
                        runOnUiThread(() -> {
                            if (session != epoch) return;
                            stopLink();
                            status.setText(error);
                        });
                    }
                });
                String ips = endpoints(requestedPort);
                runOnUiThread(() -> {
                    if (session != epoch || !foreground) {
                        next.close();
                        return;
                    }
                    server = next;
                    connecting = false;
                    status.setText("Ожидание компьютера");
                    address.setText(ips);
                    pairCode.setText(pairing.code());
                    pairCode.setTag(pairing.code());
                    start.setText("Остановить подключение");
                    next.start();
                    ui.postDelayed(refreshEndpoints, 3500);
                });
            } catch (Exception error) {
                runOnUiThread(() -> {
                    if (session != epoch) return;
                    stopLink();
                    status.setText("Запуск не удался: " + error.getLocalizedMessage());
                });
            }
        }, "FrameLink start").start();
    }

    private void stopLink() {
        ++epoch;
        ui.removeCallbacks(refreshEndpoints);
        LinkServer previous = server;
        server = null;
        if (previous != null) new Thread(previous::close, "FrameLink stop").start();
        connecting = false;
        connected = false;
        port.setEnabled(true);
        start.setText("Начать подключение");
        status.setText("Подключение выключено");
        status.setTextColor(MUTED);
        address.setText("IP-адрес появится после запуска");
        pairCode.setText("Код подключения");
        pairCode.setTag(null);
        if (mic != null) updateMicrophone();
    }

    private static String endpoints(int port) {
        var addresses = new LinkedHashSet<String>();
        try {
            for (NetworkInterface iface : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!iface.isUp() || iface.isLoopback()) continue;
                for (var ip : Collections.list(iface.getInetAddresses())) {
                    if (ip instanceof Inet4Address && ip.isSiteLocalAddress()) addresses.add(ip.getHostAddress() + ":" + port);
                }
            }
        } catch (Exception ignored) {}
        return addresses.isEmpty() ? "Включите Wi-Fi или подключите USB. Порт " + port : String.join("\n", addresses);
    }

    private void send(Wire.Packet packet) {
        LinkServer active = server;
        if (active != null) active.send(packet);
    }

    private void updateMicrophone() {
        micActive = foreground && micEnabled && connected && mic.start();
        if (!micActive) mic.stop();
        micStatus.setText(micActive ? "Передаётся на компьютер" : micEnabled ?
            (connected ? "Микрофон недоступен" : "Включится при подключении") : "Микрофон выключен");
        publishAudioState();
    }

    private void publishAudioState() {
        JSONObject audio = Wire.json("audio");
        Wire.put(audio, "active", micActive);
        send(Wire.json(audio));
    }

    private void reportCamera(String error) {
        lastCameraError = error;
        cameraError.setText(error);
        cameraError.setVisibility(View.VISIBLE);
        JSONObject message = Wire.json("cameraError");
        Wire.put(message, "message", error);
        send(Wire.json(message));
    }

    private void localSetting(String name, Object value) {
        if (updating) return;
        Wire.put(pendingSettings, name, value);
        if (localSettingsScheduled) return;
        localSettingsScheduled = true;
        ui.postDelayed(sendLocalSettings, 65);
    }

    private void sync(JSONObject state) {
        updating = true;
        int[] lenses = state.optBoolean("hasRear") && state.optBoolean("hasFront") ? new int[]{0, 1} :
            state.optBoolean("hasFront") ? new int[]{1} : new int[]{0};
        if (!Arrays.equals(cameraChoices, lenses)) {
            cameraChoices = lenses;
            setOptions(lens, lenses.length == 2 ? new String[]{"Основная", "Фронтальная"} :
                new String[]{lenses[0] == 0 ? "Основная" : "Фронтальная"});
        }
        select(lens, cameraChoices, state.optBoolean("front") ? 1 : 0);
        select(resolution, new int[]{360, 480, 720, 1080}, state.optInt("height"));
        select(fps, new int[]{24, 30, 60}, state.optInt("fps"));
        JSONArray modes = state.optJSONArray("whiteBalances");
        if (modes != null && modes.length() > 0) {
            int[] choices = new int[modes.length()];
            for (int i = 0; i < choices.length; i++) choices[i] = modes.optInt(i, 1);
            if (!Arrays.equals(choices, wbChoices)) {
                wbChoices = choices;
                setOptions(wb, Arrays.stream(choices).mapToObj(i -> BALANCES[i]).toArray(String[]::new));
            }
        }
        select(wb, wbChoices, state.optInt("wb"));
        zoom.sync(100, state.optInt("zoomMax"), state.optInt("zoom"), String.format(java.util.Locale.ROOT, "%.2f×", state.optInt("zoom") / 100f));
        exposure.sync(state.optInt("evMin"), state.optInt("evMax"), state.optInt("ev"),
            String.format(java.util.Locale.ROOT, "%+.1f EV", state.optInt("ev") * state.optDouble("evStep", 0)));
        boolean manualExposure = state.optBoolean("manualExposure");
        exposureToggle.setVisibility(state.optBoolean("hasManualExposure") ? View.VISIBLE : View.GONE);
        exposureToggle.setChecked(manualExposure);
        exposure.row.setVisibility(manualExposure ? View.GONE : View.VISIBLE);
        shutter.row.setVisibility(manualExposure ? View.VISIBLE : View.GONE);
        iso.row.setVisibility(manualExposure ? View.VISIBLE : View.GONE);
        shutter.sync(state.optInt("shutterMin"), state.optInt("shutterMax"), state.optInt("shutter"),
            String.format(java.util.Locale.ROOT, "%.2f мс", state.optInt("shutter") / 1000f));
        iso.sync(state.optInt("isoMin"), state.optInt("isoMax"), state.optInt("iso"), state.optString("iso"));
        boolean manualFocus = state.optBoolean("manualFocus");
        focusToggle.setVisibility(state.optBoolean("hasManualFocus") ? View.VISIBLE : View.GONE);
        focusToggle.setChecked(manualFocus);
        focus.row.setVisibility(manualFocus ? View.VISIBLE : View.GONE);
        focus.sync(0, 100, state.optInt("focus"), state.optInt("focus") + "%");
        updating = false;
    }

    private void layoutPreview() {
        if (preview.getWidth() == 0 || preview.getHeight() == 0) return;
        float w = preview.getWidth(), h = preview.getHeight();
        boolean sideways = bufferRotation % 180 != 0;
        float scale = Math.min(w / (sideways ? bufferHeight : bufferWidth), h / (sideways ? bufferWidth : bufferHeight));
        Matrix matrix = new Matrix();
        matrix.setTranslate(-w / 2, -h / 2);
        matrix.postScale(scale * bufferWidth / w, scale * bufferHeight / h);
        matrix.postRotate(bufferRotation);
        if (mirrorPreview) matrix.postScale(-1, 1);
        matrix.postTranslate(w / 2, h / 2);
        preview.setTransform(matrix);
    }

    private void makeUi() {
        ScrollView scroll = new ScrollView(this);
        scroll.setBackgroundColor(BG);
        scroll.setFillViewport(true);
        LinearLayout column = vertical();
        scroll.addView(column);
        scroll.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                var bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                column.setPadding(dp(20) + bars.left, dp(16) + bars.top, dp(20) + bars.right, dp(20) + bars.bottom);
            }
            return insets;
        });
        column.setPadding(dp(20), dp(16), dp(20), dp(20));
        setContentView(scroll);

        TextView title = text("FrameLink", 28, INK);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        column.addView(title);
        status = text("Подключение выключено", 14, MUTED);
        add(column, status, 4);
        previewFrame = new FrameLayout(this);
        previewFrame.setBackground(shape(0xff080a0c, 14));
        previewFrame.setClipToOutline(true);
        preview = new TextureView(this);
        previewFrame.addView(preview, new FrameLayout.LayoutParams(-1, -1));
        add(column, previewFrame, 18, dp(236));
        format = text("", 12, MUTED);
        add(column, format, 8);
        cameraError = text("", 14, 0xffffb5ae);
        cameraError.setVisibility(View.GONE);
        add(column, cameraError, 4);

        LinearLayout connection = panel(column, "Подключение");
        address = text("IP-адрес появится после запуска", 15, INK);
        address.setTypeface(Typeface.MONOSPACE);
        address.setOnClickListener(view -> {
            if (server == null) return;
            String endpoint = address.getText().toString().split("\n", 2)[0];
            if (endpoint.matches("[0-9.]+:[0-9]+")) copy(endpoint);
        });
        add(connection, address, 10);
        pairCode = text("Код подключения", 14, MINT);
        pairCode.setTypeface(Typeface.MONOSPACE);
        pairCode.setPadding(0, dp(6), 0, dp(6));
        pairCode.setOnClickListener(view -> { if (view.getTag() != null) copy(view.getTag().toString()); });
        add(connection, pairCode, 4);
        LinearLayout portRow = new LinearLayout(this);
        portRow.setGravity(Gravity.CENTER_VERTICAL);
        portRow.addView(text("Порт", 14, MUTED), new LinearLayout.LayoutParams(0, -2, 1));
        port = new EditText(this);
        port.setTextColor(INK);
        port.setSingleLine();
        port.setText(Integer.toString(getPreferences(MODE_PRIVATE).getInt("port", 4747)));
        port.setInputType(InputType.TYPE_CLASS_NUMBER);
        portRow.addView(port, new LinearLayout.LayoutParams(dp(104), -2));
        add(connection, portRow, 4);
        start = new Button(this);
        start.setAllCaps(false);
        start.setTextColor(0xff10241e);
        start.setText("Начать подключение");
        start.setBackground(shape(MINT, 9));
        start.setOnClickListener(view -> { if (server != null || connecting) stopLink(); else startLink(); });
        add(connection, start, 10, dp(46));

        LinearLayout controls = panel(column, "Камера");
        lens = spinner(controls, "Объектив", new String[]{"Основная", "Фронтальная"},
            index -> { if (index < cameraChoices.length) localSetting("front", cameraChoices[index] == 1); });
        resolution = spinner(controls, "Разрешение", new String[]{"360p", "480p", "720p", "1080p"},
            index -> localSetting("height", new int[]{360, 480, 720, 1080}[index]));
        fps = spinner(controls, "Частота кадров", new String[]{"24 FPS", "30 FPS", "60 FPS"},
            index -> localSetting("fps", new int[]{24, 30, 60}[index]));
        resolution.setSelection(2, false);
        fps.setSelection(1, false);
        zoom = new Slider(controls, "Приближение", "zoom");
        wb = spinner(controls, "Баланс белого", new String[]{"Авто"},
            index -> { if (index < wbChoices.length) localSetting("wb", wbChoices[index]); });
        exposureToggle = toggle(controls, "Ручная экспозиция");
        exposureToggle.setOnCheckedChangeListener((button, checked) -> localSetting("manualExposure", checked));
        exposure = new Slider(controls, "Экспокоррекция", "ev");
        shutter = new Slider(controls, "Выдержка", "shutter");
        iso = new Slider(controls, "ISO", "iso");
        focusToggle = toggle(controls, "Ручной фокус");
        focusToggle.setOnCheckedChangeListener((button, checked) -> localSetting("manualFocus", checked));
        focus = new Slider(controls, "Фокус", "focus");

        LinearLayout audio = panel(column, "Звук");
        micToggle = toggle(audio, "Микрофон телефона");
        micToggle.setOnCheckedChangeListener((button, checked) -> {
            if (updating) return;
            if (checked && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 2);
                return;
            }
            micEnabled = checked;
            updateMicrophone();
        });
        micStatus = text("Микрофон выключен", 13, MUTED);
        add(audio, micStatus, 2);
    }

    private void copy(CharSequence value) {
        getSystemService(ClipboardManager.class).setPrimaryClip(ClipData.newPlainText("FrameLink", value));
        if (android.os.Build.VERSION.SDK_INT < 33) Toast.makeText(this, "Скопировано", Toast.LENGTH_SHORT).show();
    }

    private LinearLayout vertical() {
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        return box;
    }

    private LinearLayout panel(LinearLayout column, String name) {
        LinearLayout panel = vertical();
        panel.setBackground(shape(PANEL, 14));
        panel.setPadding(dp(15), dp(14), dp(15), dp(16));
        TextView heading = text(name, 17, INK);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        panel.addView(heading);
        add(column, panel, 16);
        return panel;
    }

    private Spinner spinner(LinearLayout parent, String name, String[] values, IntConsumer onSelection) {
        LinearLayout row = new LinearLayout(this);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.addView(text(name, 14, INK), new LinearLayout.LayoutParams(0, -2, 1));
        Spinner spinner = new Spinner(this);
        spinner.setContentDescription(name);
        setOptions(spinner, values);
        row.addView(spinner, new LinearLayout.LayoutParams(-2, dp(44)));
        spinner.setOnItemSelectedListener(new android.widget.AdapterView.OnItemSelectedListener() {
            @Override public void onItemSelected(android.widget.AdapterView<?> parent, View child, int position, long id) {
                if (spinner.isPressed() || !updating && Boolean.TRUE.equals(spinner.getTag())) onSelection.accept(position);
                spinner.setTag(Boolean.FALSE);
            }
            @Override public void onNothingSelected(android.widget.AdapterView<?> parent) {}
        });
        spinner.setOnTouchListener((view, event) -> {
            if (event.getAction() == android.view.MotionEvent.ACTION_DOWN) spinner.setTag(Boolean.TRUE);
            return false;
        });
        spinner.setOnKeyListener((view, key, event) -> {
            if (event.getAction() == android.view.KeyEvent.ACTION_DOWN) spinner.setTag(Boolean.TRUE);
            return false;
        });
        add(parent, row, 4);
        return spinner;
    }

    private void setOptions(Spinner spinner, String[] values) {
        spinner.setTag(Boolean.FALSE);
        ArrayAdapter<String> adapter = new ArrayAdapter<>(this, android.R.layout.simple_spinner_item, values);
        adapter.setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        spinner.setAdapter(adapter);
    }

    private void select(Spinner spinner, int[] values, int selected) {
        for (int i = 0; i < values.length; i++) {
            if (values[i] != selected || spinner.getSelectedItemPosition() == i) continue;
            spinner.setTag(Boolean.FALSE);
            spinner.setSelection(i, false);
            return;
        }
    }

    private Switch toggle(LinearLayout layout, String name) {
        Switch toggle = new Switch(this);
        toggle.setText(name);
        toggle.setTextSize(14);
        toggle.setTextColor(INK);
        add(layout, toggle, 8, dp(44));
        return toggle;
    }

    private final class Slider {
        final LinearLayout row;
        final SeekBar control;
        final TextView readout;
        boolean dragged;
        int minimum;

        Slider(LinearLayout layout, String label, String key) {
            row = vertical();
            LinearLayout header = new LinearLayout(MainActivity.this);
            header.addView(text(label, 14, INK), new LinearLayout.LayoutParams(0, -2, 1));
            readout = text("", 13, MUTED);
            header.addView(readout);
            row.addView(header);
            control = new SeekBar(MainActivity.this);
            control.setContentDescription(label);
            control.setProgressTintList(ColorStateList.valueOf(MINT));
            control.setThumbTintList(ColorStateList.valueOf(MINT));
            row.addView(control, new LinearLayout.LayoutParams(-1, dp(36)));
            control.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
                @Override public void onProgressChanged(SeekBar bar, int progress, boolean fromUser) {
                    if (fromUser) localSetting(key, progress + minimum);
                }
                @Override public void onStartTrackingTouch(SeekBar bar) { dragged = true; }
                @Override public void onStopTrackingTouch(SeekBar bar) { dragged = false; }
            });
            add(layout, row, 12);
        }

        void sync(int min, int max, int value, String display) {
            readout.setText(display);
            if (dragged) return;
            minimum = min;
            control.setMax(Math.max(0, max - min));
            control.setProgress(value - min);
            control.setEnabled(max > min);
        }
    }

    private TextView text(String value, int sp, int color) {
        TextView view = new TextView(this);
        view.setText(value);
        view.setTextColor(color);
        view.setTextSize(sp);
        return view;
    }

    private GradientDrawable shape(int color, int radius) {
        var drawable = new GradientDrawable();
        drawable.setColor(color);
        drawable.setCornerRadius(dp(radius));
        return drawable;
    }

    private void add(LinearLayout layout, View view, int top) { add(layout, view, top, -2); }

    private void add(LinearLayout layout, View view, int top, int height) {
        var params = new LinearLayout.LayoutParams(-1, height);
        params.topMargin = dp(top);
        layout.addView(view, params);
    }

    private int dp(int value) { return (int) (getResources().getDisplayMetrics().density * value + 0.5f); }
}
