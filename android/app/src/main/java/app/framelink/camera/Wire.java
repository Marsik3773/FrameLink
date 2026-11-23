package app.framelink.camera;

import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

final class Wire {
    static final int DELTA = 1, KEY = 2, JSON = 3, PCM = 4;
    record Packet(int type, long timestamp, byte[] data) {}

    static Packet json(JSONObject object) {
        return new Packet(JSON, 0, object.toString().getBytes(StandardCharsets.UTF_8));
    }

    static JSONObject json(String type) {
        JSONObject result = new JSONObject();
        put(result, "type", type);
        return result;
    }

    static void put(JSONObject target, String key, Object value) {
        try {
            target.put(key, value);
        } catch (org.json.JSONException e) {
            throw new IllegalArgumentException(key, e);
        }
    }
}
