package app.framelink.camera;

import android.Manifest;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ComponentName;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.IBinder;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.content.pm.PackageManager;
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
import android.widget.*;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.Arrays;
import java.util.function.IntConsumer;

public final class MainActivity extends Activity {
    private static final int BG = 0xff101315, PANEL = 0xff191e20, INK = 0xffedf3f1;
    private static final int MUTED = 0xffa7b5b0, MINT = 0xffa5e9d2;
    private static final String[] BALANCES = {"", "Авто", "Лампа накаливания", "Люминесцентный", "Тёплый люминесцентный",
        "Дневной свет", "Облачность", "Сумерки", "Тень"};
    private final Handler ui = new Handler(Looper.getMainLooper());
    private StreamService stream;
    private boolean bound, wantMicrophone;
    private LinearLayout cameraPanel, cameraActions, connection;
    private ViewFlipper pages;
    private Button settingsButton;
    private boolean settingsOpen;
    private boolean connectionOpen;
    private final StreamService.Listener observer = new StreamService.Listener() {
        @Override public void changed() { render(); }
        @Override public void settings(JSONObject state) { sync(state); }
        @Override public void preview(int width, int height, int rotation, boolean front) {
            bufferWidth = width;
            bufferHeight = height;
            bufferRotation = rotation;
            mirrorPreview = front;
            layoutPreview();
        }
    };
    private final ServiceConnection binding = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) {
            stream = ((StreamService.LocalBinder) binder).service();
            stream.observe(observer);
            updateRotation();
            if (preview.isAvailable()) stream.preview(preview.getSurfaceTexture());
            ui.post(refreshEndpoints);
        }
        @Override public void onServiceDisconnected(ComponentName name) {
            stream = null;
            render();
        }
    };
    private JSONObject pendingSettings = new JSONObject();
    private boolean localSettingsScheduled;
    private final Runnable sendLocalSettings = () -> {
        localSettingsScheduled = false;
        JSONObject changes = pendingSettings;
        pendingSettings = new JSONObject();
        if (stream != null) stream.settings(changes);
    };
    private boolean updating;
    private int bufferWidth = 1280, bufferHeight = 720, bufferRotation;
    private int[] cameraChoices = {0, 1}, wbChoices = {1};
    private boolean mirrorPreview;
    private final Runnable refreshEndpoints = new Runnable() {
        @Override public void run() {
            if (stream == null) return;
            if (stream.available) address.setText(StreamService.endpoints(stream.port));
            ui.postDelayed(this, 3500);
        }
    };
    private TextureView preview;
    private FrameLayout previewFrame;
    private EditText port;
    private TextView status, address, format, cameraError;
    private Button start;
    private Switch micToggle, exposureToggle, focusToggle;
    private Spinner lens, resolution, fps, wb;
    private Slider zoom, exposure, shutter, iso, focus;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        wantMicrophone = getPreferences(MODE_PRIVATE).getBoolean("mic", false)
            && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
        makeUi();
        preview.setSurfaceTextureListener(new TextureView.SurfaceTextureListener() {
            @Override public void onSurfaceTextureAvailable(SurfaceTexture texture, int w, int h) {
                if (stream != null) stream.preview(texture);
            }
            @Override public void onSurfaceTextureSizeChanged(SurfaceTexture texture, int w, int h) {}
            @Override public boolean onSurfaceTextureDestroyed(SurfaceTexture texture) {
                if (stream != null) stream.preview(null);
                return true;
            }
            @Override public void onSurfaceTextureUpdated(SurfaceTexture texture) {}
        });
        previewFrame.addOnLayoutChangeListener((view, l,t,r,b, oldL,oldT,oldR,oldB) -> layoutPreview());
        render();
    }

    @Override protected void onStart() {
        super.onStart();
        bound = bindService(new Intent(this, StreamService.class), binding, BIND_AUTO_CREATE);
    }

    @Override protected void onStop() {
        ui.removeCallbacks(refreshEndpoints);
        ui.removeCallbacks(sendLocalSettings);
        if (localSettingsScheduled) sendLocalSettings.run();
        if (stream != null) {
            stream.preview(null);
            stream.observe(null);
            stream = null;
        }
        if (bound) { unbindService(binding); bound = false; }
        super.onStop();
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        updateRotation();
        layoutPreview();
    }

    @Override public void onRequestPermissionsResult(int request, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(request, permissions, results);
        if (request == 1 && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) activate();
        if (request == 2) {
            wantMicrophone = checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED;
            getPreferences(MODE_PRIVATE).edit().putBoolean("mic", wantMicrophone).apply();
            if (stream != null) stream.microphone(wantMicrophone);
            render();
        }
    }

    private void updateRotation() {
        if (stream == null) return;
        int rotation = getWindowManager().getDefaultDisplay().getRotation();
        stream.rotation(rotation == Surface.ROTATION_90 ? 90 : rotation == Surface.ROTATION_180 ? 180
            : rotation == Surface.ROTATION_270 ? 270 : 0);
    }

    private void startAction() {
        if (stream != null && (stream.available || stream.starting)) {
            stream.stopAccess();
            return;
        }
        var permissions = new java.util.ArrayList<String>();
        if (checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED)
            permissions.add(Manifest.permission.CAMERA);
        var prefs = getPreferences(MODE_PRIVATE);
        if (android.os.Build.VERSION.SDK_INT >= 33 && !prefs.getBoolean("askedNotice", false)
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            prefs.edit().putBoolean("askedNotice", true).apply();
            permissions.add(Manifest.permission.POST_NOTIFICATIONS);
        }
        if (!permissions.isEmpty()) requestPermissions(permissions.toArray(new String[0]), 1);
        else activate();
    }

    private void activate() {
        int requestedPort;
        try {
            requestedPort = Integer.parseInt(port.getText().toString());
            if (requestedPort < 1024 || requestedPort > 65535) throw new NumberFormatException();
        } catch (NumberFormatException invalid) {
            port.setError("Порт от 1024 до 65535");
            return;
        }
        getPreferences(MODE_PRIVATE).edit().putInt("port", requestedPort).apply();
        startForegroundService(new Intent(this, StreamService.class).setAction(StreamService.START)
            .putExtra("port", requestedPort).putExtra("mic", wantMicrophone));
    }

    private void render() {
        boolean active = stream != null && (stream.available || stream.starting);
        boolean live = stream != null && stream.connected;
        boolean waiting = stream != null && stream.starting;
        start.setText(waiting ? "Отменить" : active ? "Закрыть доступ" : "Открыть доступ");
        port.setEnabled(!active);
        port.setVisibility(active ? View.GONE : View.VISIBLE);
        ((View) port.getParent()).setVisibility(active ? View.GONE : View.VISIBLE);
        if (active) port.setText(Integer.toString(stream.port));
        status.setText(live ? "Камера подключена" : waiting ? "Запуск…" : active ? "Доступна" : "Выключено");
        status.setTextColor(live ? MINT : MUTED);
        address.setVisibility(active && !waiting ? View.VISIBLE : View.GONE);
        if (active && !waiting) address.setText(StreamService.endpoints(stream.port));
        previewFrame.setVisibility(live ? View.VISIBLE : View.GONE);
        if (!live) { settingsOpen = false; connectionOpen = false; }
        cameraActions.setVisibility(live ? View.VISIBLE : View.GONE);
        cameraPanel.setVisibility(live && settingsOpen ? View.VISIBLE : View.GONE);
        connection.setVisibility(!live || connectionOpen ? View.VISIBLE : View.GONE);
        settingsButton.setText(settingsOpen ? "Готово" : "Настройки");
        JSONObject video = stream == null ? null : stream.video();
        format.setVisibility(live && video != null ? View.VISIBLE : View.GONE);
        if (video != null) {
            boolean vertical = video.optInt("rotation") % 180 != 0;
            format.setText(video.optInt(vertical ? "height" : "width") + " × " +
                video.optInt(vertical ? "width" : "height") + " · " + video.optInt("fps") + " FPS");
        }
        String error = stream == null ? "" : stream.error;
        cameraError.setVisibility(error.isEmpty() ? View.GONE : View.VISIBLE);
        cameraError.setText(error);
        if (active) wantMicrophone = stream.micEnabled;
        updating = true;
        micToggle.setChecked(wantMicrophone);
        updating = false;
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
        int frameWidth = previewFrame.getWidth(), frameHeight = previewFrame.getHeight();
        if (frameWidth == 0 || frameHeight == 0) return;
        boolean sideways = bufferRotation % 180 != 0;
        float scale = Math.max(frameWidth / (float) (sideways ? bufferHeight : bufferWidth),
            frameHeight / (float) (sideways ? bufferWidth : bufferHeight));
        int width = Math.max(1, Math.round(bufferWidth * scale));
        int height = Math.max(1, Math.round(bufferHeight * scale));
        FrameLayout.LayoutParams params = (FrameLayout.LayoutParams) preview.getLayoutParams();
        if (params.width != width || params.height != height)
            preview.setLayoutParams(new FrameLayout.LayoutParams(width, height, Gravity.CENTER));
        preview.setRotation(bufferRotation);
        preview.setScaleX(mirrorPreview && !sideways ? -1 : 1);
        preview.setScaleY(mirrorPreview && sideways ? -1 : 1);
    }

    private void makeUi() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN |
            View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_FULLSCREEN |
            View.SYSTEM_UI_FLAG_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY);
        FrameLayout screen = new FrameLayout(this);
        screen.setBackgroundColor(BG);
        previewFrame = new FrameLayout(this);
        previewFrame.setBackgroundColor(0xff080a0c);
        preview = new TextureView(this);
        previewFrame.addView(preview, new FrameLayout.LayoutParams(1, 1, Gravity.CENTER));
        screen.addView(previewFrame, new FrameLayout.LayoutParams(-1, -1));

        FrameLayout chrome = new FrameLayout(this);
        chrome.setPadding(dp(16), dp(12), dp(16), dp(12));
        screen.addView(chrome, new FrameLayout.LayoutParams(-1, -1));
        chrome.setOnApplyWindowInsetsListener((view, insets) -> {
            if (android.os.Build.VERSION.SDK_INT >= 30) {
                var cutout = insets.getInsets(WindowInsets.Type.displayCutout());
                chrome.setPadding(dp(16) + cutout.left, dp(12) + cutout.top,
                    dp(16) + cutout.right, dp(12) + cutout.bottom);
            }
            return insets;
        });
        setContentView(screen);

        LinearLayout header = vertical();
        header.setPadding(dp(12), dp(8), dp(12), dp(8));
        header.setBackground(shape(0xce15191b, 10));
        chrome.addView(header, new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.START));
        TextView title = text("FrameLink", 18, INK);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        header.addView(title);
        status = text("Выключено", 12, MUTED);
        header.addView(status);
        format = text("", 12, INK);
        header.addView(format);
        cameraError = text("", 13, 0xffffb5ae);
        header.addView(cameraError);

        LinearLayout dock = vertical();
        chrome.addView(dock, new FrameLayout.LayoutParams(-1, -2, Gravity.BOTTOM));
        connection = panel(dock, "Подключение");
        address = text("", 15, INK);
        address.setTypeface(Typeface.MONOSPACE);
        address.setOnClickListener(view -> {
            if (stream == null || !stream.available) return;
            String endpoint = address.getText().toString().split("\n", 2)[0];
            if (endpoint.matches("[0-9.]+:[0-9]+")) copy(endpoint);
        });
        add(connection, address, 10);
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
        start.setText("Открыть доступ");
        start.setBackground(shape(MINT, 9));
        start.setOnClickListener(view -> startAction());
        add(connection, start, 10, dp(46));

        micToggle = toggle(connection, "Микрофон");
        micToggle.setOnCheckedChangeListener((button, checked) -> {
            if (updating) return;
            if (checked && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 2);
                return;
            }
            wantMicrophone = checked;
            getPreferences(MODE_PRIVATE).edit().putBoolean("mic", checked).apply();
            if (stream != null) stream.microphone(checked);
        });

        cameraPanel = panel(dock, "Камера");
        LinearLayout tabs = new LinearLayout(this);
        cameraPanel.addView(tabs);
        pages = new ViewFlipper(this);
        cameraPanel.addView(pages);
        LinearLayout controls = settingsPage(tabs, "Кадр");
        LinearLayout lighting = settingsPage(tabs, "Свет");
        LinearLayout details = settingsPage(tabs, "Цвет и фокус");
        lens = spinner(controls, "Объектив", new String[]{"Основная", "Фронтальная"},
            index -> { if (index < cameraChoices.length) localSetting("front", cameraChoices[index] == 1); });
        resolution = spinner(controls, "Разрешение", new String[]{"360p", "480p", "720p", "1080p"},
            index -> localSetting("height", new int[]{360, 480, 720, 1080}[index]));
        fps = spinner(controls, "Частота кадров", new String[]{"24 FPS", "30 FPS", "60 FPS"},
            index -> localSetting("fps", new int[]{24, 30, 60}[index]));
        resolution.setSelection(2, false);
        fps.setSelection(1, false);
        zoom = new Slider(controls, "Приближение", "zoom");
        wb = spinner(details, "Баланс белого", new String[]{"Авто"},
            index -> { if (index < wbChoices.length) localSetting("wb", wbChoices[index]); });
        exposureToggle = toggle(lighting, "Ручная экспозиция");
        exposureToggle.setOnCheckedChangeListener((button, checked) -> localSetting("manualExposure", checked));
        exposure = new Slider(lighting, "Экспокоррекция", "ev");
        shutter = new Slider(lighting, "Выдержка", "shutter");
        iso = new Slider(lighting, "ISO", "iso");
        focusToggle = toggle(details, "Ручной фокус");
        focusToggle.setOnCheckedChangeListener((button, checked) -> localSetting("manualFocus", checked));
        focus = new Slider(details, "Фокус", "focus");

        cameraActions = new LinearLayout(this);
        add(dock, cameraActions, 8);
        overlayButton(cameraActions, "Подключение", () -> {
            connectionOpen = !connectionOpen;
            settingsOpen = false;
            render();
        });
        settingsButton = overlayButton(cameraActions, "Настройки", () -> {
            settingsOpen = !settingsOpen;
            connectionOpen = false;
            render();
        });
    }

    private LinearLayout settingsPage(LinearLayout tabs, String label) {
        int index = pages.getChildCount();
        LinearLayout page = vertical();
        pages.addView(page);
        overlayButton(tabs, label, () -> pages.setDisplayedChild(index));
        return page;
    }

    private Button overlayButton(LinearLayout parent, String label, Runnable action) {
        Button button = new Button(this);
        button.setText(label);
        button.setTextColor(INK);
        button.setTextSize(13);
        button.setAllCaps(false);
        button.setBackground(shape(0xe722292a, 8));
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(0, dp(44), 1);
        if (parent.getChildCount() > 0) params.leftMargin = dp(8);
        parent.addView(button, params);
        button.setOnClickListener(view -> action.run());
        return button;
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
        panel.setBackground(shape(0xe9191e20, 12));
        panel.setPadding(dp(15), dp(14), dp(15), dp(16));
        TextView heading = text(name, 17, INK);
        heading.setTypeface(Typeface.DEFAULT_BOLD);
        panel.addView(heading);
        add(column, panel, 8);
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
            add(layout, row, 4);
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
