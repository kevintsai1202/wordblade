package com.wordblade.gateway.plane3d;

import com.wordblade.gateway.ai.AiError;
import com.wordblade.gateway.ai.AiSchemaException;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import org.springframework.core.io.ClassPathResource;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * 「用說的」（spec §5.8）回應的解析與驗證：移植原專案 plane3d_ai.parse_response 與 validate_plane3d 的範圍、時間檢查。
 * 範圍表是 scripts/plane3d/build-prompt.mjs 從原專案的姿勢數學產生的資源檔（只有一份來源）。
 * 姿勢路徑能不能用（投影、凸四邊形）要用同一份 JS 數學算，由桌面檢查、不過就回饋。
 * 和原專案的差別：t 超過區段長度直接擋（原專案默默夾住，與提示詞的說法不一致）。
 */
public class Plane3dParser {

    /** 拒答代碼 */
    static final Set<String> REFUSAL_CODES = Set.of("off-topic", "too-complex");
    /** 姿勢欄位與滿版平面的值 */
    private static final List<String> POSE = List.of("rx", "ry", "rz", "size", "px", "py");
    /** 顏色 */
    private static final Pattern COLOR = Pattern.compile("#[0-9a-fA-F]{6}");
    /** markdown 圍欄 */
    private static final Pattern FENCE = Pattern.compile("^```[a-zA-Z]*\\s*|\\s*```$");

    /**
     * 解析結果。
     *
     * @param refusal  拒答代碼；有提議時為 null
     * @param proposal 提議（只含模型回的欄位：keys 一定有，float、edges、background、color、shadow 選填）
     */
    public record Result(String refusal, ObjectNode proposal) {}

    private final JsonMapper json;
    private final JsonNode ranges;

    public Plane3dParser(JsonMapper json, JsonNode ranges) {
        this.json = json;
        this.ranges = ranges;
    }

    /** 從資源檔 plane3d/ranges.json 建立 */
    public static Plane3dParser fromResources(JsonMapper json) {
        try {
            return new Plane3dParser(json, json.readTree(new ClassPathResource("plane3d/ranges.json").getContentAsString(StandardCharsets.UTF_8)));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /**
     * 解析並檢查。length：區段長度（秒）；currentEdges：目前的 edges（模型沒回時用它算頭尾過場）。
     * 不合格丟 AiSchemaException（帶要回饋給模型的錯誤）。
     */
    public Result parse(String text, double length, boolean currentEdges) {
        JsonNode v = jsonObject(text);
        if (v.has("refused")) {
            String code = v.path("refused").asString("");
            if (!REFUSAL_CODES.contains(code)) throw fail("refused 只能是 off-topic 或 too-complex");
            return new Result(code, null);
        }
        List<AiError> errors = new ArrayList<>();
        ObjectNode out = json.createObjectNode();
        JsonNode keys = v.path("keys");
        int maxKeys = ranges.path("maxKeys").asInt(20);
        if (!keys.isArray() || keys.isEmpty() || keys.size() > maxKeys) throw fail("keys 必須是 1～" + maxKeys + " 個關鍵幀物件的陣列");
        boolean edges = v.has("edges") ? v.path("edges").asBoolean(true) : currentEdges;
        ArrayNode outKeys = out.putArray("keys");
        for (int i = 0; i < keys.size(); i++) outKeys.add(key(keys.get(i), i, length, errors));
        if (errors.isEmpty()) checkTimes(outKeys, length, edges, errors);

        if (v.has("float")) {
            JsonNode f = v.get("float");
            if (f.isNull()) out.putNull("float");
            else if (f.isObject() && inRange(f, "rx", ranges.path("float")) && inRange(f, "ry", ranges.path("float")) && inRange(f, "period", ranges.path("float"))) {
                out.putObject("float").put("rx", f.get("rx").asDouble()).put("ry", f.get("ry").asDouble()).put("period", f.get("period").asDouble());
            } else errors.add(schema("float 要是 null 或 {rx, ry（0～15 度）, period（1～10 秒）}"));
        }
        if (v.has("edges")) {
            if (v.get("edges").isBoolean()) out.put("edges", v.get("edges").asBoolean());
            else errors.add(schema("edges 要是 true 或 false"));
        }
        if (v.has("background")) {
            String bg = v.path("background").asString("");
            boolean ok = false;
            for (JsonNode b : ranges.path("backgrounds")) ok |= b.asString().equals(bg);
            if (ok) out.put("background", bg);
            else errors.add(schema("background 只能是 studio、grid、blur、color"));
        }
        if (v.has("color")) {
            String c = v.path("color").asString("");
            if (COLOR.matcher(c).matches()) out.put("color", c);
            else errors.add(schema("color 要是 #RRGGBB"));
        }
        if (v.has("shadow")) {
            double s = v.path("shadow").asDouble(-1);
            if (v.get("shadow").isNumber() && s >= 0 && s <= 1) out.put("shadow", s);
            else errors.add(schema("shadow 要是 0～1 的數字"));
        }
        if (!errors.isEmpty()) throw new AiSchemaException(errors);
        return new Result(null, out);
    }

    /** 一個關鍵幀：補預設值（滿版平面、start、inOut），只留已知欄位，檢查範圍 */
    private ObjectNode key(JsonNode k, int i, double length, List<AiError> errors) {
        ObjectNode out = json.createObjectNode();
        if (!k.isObject()) {
            errors.add(schema("keys[" + i + "] 要是物件"));
            return out;
        }
        String anchor = k.path("anchor").asString("start");
        if (!anchor.equals("start") && !anchor.equals("end")) errors.add(schema("keys[" + i + "].anchor 只能是 start 或 end"));
        out.put("anchor", anchor);
        double t = k.path("t").asDouble(0);
        if (!(t >= 0)) errors.add(schema("keys[" + i + "].t 要 ≥ 0"));
        if (t > length) errors.add(schema("keys[" + i + "].t（" + t + " 秒）超過區段長度 " + length + " 秒"));
        out.put("t", t);
        for (String p : POSE) {
            double val = k.has(p) ? k.path(p).asDouble(Double.NaN) : (p.equals("size") ? 1 : 0);
            JsonNode r = ranges.path("keys").path(p);
            if (!(val >= r.get(0).asDouble() && val <= r.get(1).asDouble())) {
                errors.add(schema("keys[" + i + "]." + p + " 要在 " + r.get(0).asDouble() + "～" + r.get(1).asDouble() + " 之間"));
            }
            out.put(p, val);
        }
        String ease = k.path("ease").asString("inOut");
        boolean easeOk = false;
        for (JsonNode e : ranges.path("eases")) easeOk |= e.asString().equals(ease);
        if (!easeOk) errors.add(schema("keys[" + i + "].ease 只能是 inOut、linear、in、out"));
        out.put("ease", ease);
        return out;
    }

    /** 換算成區段時間（edges 開時頭尾各留過場，夾在 [r, L−r]）後要嚴格遞增（同原專案 key_times） */
    private void checkTimes(ArrayNode keys, double length, boolean edges, List<AiError> errors) {
        double r = edges ? Math.min(ranges.path("edgeRamp").asDouble(0.6), length / 4) : 0;
        double prev = Double.NEGATIVE_INFINITY;
        for (int i = 0; i < keys.size(); i++) {
            JsonNode k = keys.get(i);
            double t = k.get("t").asDouble();
            double time = Math.min(length - r, Math.max(r, k.get("anchor").asString().equals("start") ? r + t : length - r - t));
            if (time <= prev) {
                errors.add(schema("keys 換算成時間後要嚴格遞增（keys[" + i + "] 沒有排在前一個後面）"));
                return;
            }
            prev = time;
        }
    }

    /** f[key] 是數字且在範圍內 */
    private static boolean inRange(JsonNode f, String key, JsonNode table) {
        JsonNode r = table.path(key);
        return f.path(key).isNumber() && f.get(key).asDouble() >= r.get(0).asDouble() && f.get(key).asDouble() <= r.get(1).asDouble();
    }

    /** 從回應取出第一個 JSON 物件（容忍 ```json 圍欄與前後雜訊） */
    private JsonNode jsonObject(String text) {
        String t = text == null ? "" : text.strip();
        if (t.startsWith("```")) t = FENCE.matcher(t).replaceAll("");
        JsonNode v = tryRead(t);
        if (v == null) {
            int a = t.indexOf('{');
            int b = t.lastIndexOf('}');
            v = a >= 0 && b > a ? tryRead(t.substring(a, b + 1)) : null;
        }
        if (v == null || !v.isObject()) throw new AiSchemaException(List.of(new AiError("json", null, "回應不是 JSON 物件", null, null)));
        return v;
    }

    /** 讀 JSON，失敗回 null */
    private JsonNode tryRead(String t) {
        try {
            return json.readTree(t);
        } catch (JacksonException e) {
            return null;
        }
    }

    /** 結構錯誤 */
    private static AiError schema(String message) {
        return new AiError("schema", null, message, null, null);
    }

    /** 單一錯誤 */
    private static AiSchemaException fail(String message) {
        return new AiSchemaException(List.of(schema(message)));
    }
}
