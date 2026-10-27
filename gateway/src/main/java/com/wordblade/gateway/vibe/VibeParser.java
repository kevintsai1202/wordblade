package com.wordblade.gateway.vibe;

import com.wordblade.gateway.ai.*;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * 模型回應的解析與結構檢查（移植原專案 anim_ai.parse_response 的「閘道這一半」）。
 * 插件程式本身（結構、編譯、試跑）由桌面沙盒的直譯器驗證，錯誤再回饋；這裡只擋 JSON 與整體結構，
 * 並只把結構化欄位往下傳（模型的自由文字一律丟掉，介面不顯示模型寫的文字，spec §5.7）。
 */
public class VibeParser {

    /** 拒答代碼（介面依代碼顯示固定文字） */
    static final Set<String> REFUSAL_CODES = Set.of("off-topic", "unsafe", "too-complex");
    /** 產生方式：只填參數／組合內建插件／修改內建插件／從頭寫 */
    static final Set<String> MODES = Set.of("params", "compose", "modify", "new");
    /** 一次回應最多新寫幾個插件 */
    static final int MAX_COMPONENTS = 4;
    /** 圖層、音效各最多幾個 */
    static final int MAX_ITEMS = 8;
    /** 插件往下傳的欄位 */
    private static final List<String> COMPONENT_KEYS = List.of("kind", "name", "description", "tags", "category", "params", "code");
    /** 圖層引用：#n 或內建插件 id */
    private static final Pattern REF = Pattern.compile("#\\d{1,2}|[a-z][a-z0-9-]{0,40}");
    /** markdown 圍欄 */
    private static final Pattern FENCE = Pattern.compile("^```[a-zA-Z]*\\s*|\\s*```$");

    /**
     * 解析結果：拒答（refusal 有值），或產生的動畫。
     *
     * @param refusal      拒答代碼；產生時為 null
     * @param mode         產生方式
     * @param anim         {title, layers, sounds}
     * @param components   新寫的插件（code 已接成字串，只留已知欄位）
     * @param targetPhrase 畫面上要指向的物件（英文名詞片語，可能是空字串）
     */
    public record Parsed(String refusal, String mode, JsonNode anim, List<ObjectNode> components, String targetPhrase) {}

    private final JsonMapper json;

    public VibeParser(JsonMapper json) {
        this.json = json;
    }

    /** 解析並檢查；不合格丟 AiSchemaException（帶要回饋給模型的錯誤） */
    public Parsed parse(String text) {
        JsonNode v = jsonObject(text);
        if (v.path("refused").asBoolean(false)) {
            String code = v.path("code").asString("");
            return new Parsed(REFUSAL_CODES.contains(code) ? code : "off-topic", null, null, List.of(), "");
        }
        List<AiError> errors = new ArrayList<>();
        String mode = v.path("mode").asString("");
        if (!MODES.contains(mode)) errors.add(schema("mode 只能是 " + String.join("、", List.of("params", "compose", "modify", "new"))));

        JsonNode rawComps = v.path("components");
        if (!rawComps.isMissingNode() && !rawComps.isNull() && (!rawComps.isArray() || rawComps.size() > MAX_COMPONENTS)) {
            throw new AiSchemaException(List.of(schema("components 要是陣列、最多 " + MAX_COMPONENTS + " 個")));
        }
        List<ObjectNode> comps = new ArrayList<>();
        for (int i = 0; rawComps.isArray() && i < rawComps.size(); i++) {
            JsonNode c = rawComps.get(i);
            if (!c.isObject()) {
                errors.add(new AiError("schema", i, "components[" + i + "] 要是物件", null, null));
                continue;
            }
            ObjectNode out = json.createObjectNode();
            for (String k : COMPONENT_KEYS) if (c.has(k)) out.set(k, c.get(k));
            if (c.path("code").isArray()) {
                List<String> lines = new ArrayList<>();
                c.get("code").forEach(line -> lines.add(line.asString("")));
                out.put("code", String.join("\n", lines));
            }
            comps.add(out);
        }

        JsonNode anim = v.path("anim");
        if (!anim.isObject()) {
            errors.add(schema("缺少 anim 物件"));
            throw new AiSchemaException(errors);
        }
        ArrayNode layers = items(anim, "layers", errors);
        ArrayNode sounds = items(anim, "sounds", errors);
        if (layers.isEmpty() && sounds.isEmpty()) errors.add(schema("anim.layers、anim.sounds 要是陣列、各 ≤ " + MAX_ITEMS + " 個、至少有一個"));
        checkRefs(layers, "layers", comps.size(), errors);
        checkRefs(sounds, "sounds", comps.size(), errors);
        if (!errors.isEmpty()) throw new AiSchemaException(errors);

        ObjectNode outAnim = json.createObjectNode();
        String title = anim.path("title").asString("").replaceAll("[\\x00-\\x1f\\x7f]", "");
        outAnim.put("title", title.codePointCount(0, title.length()) > 30 ? title.substring(0, title.offsetByCodePoints(0, 30)) : title);
        outAnim.set("layers", layers);
        outAnim.set("sounds", sounds);
        String phrase = v.path("target").path("phrase").asString("").replaceAll("[^A-Za-z0-9 \\-]", "").strip();
        return new Parsed(null, mode, outAnim, comps, phrase.length() > 60 ? phrase.substring(0, 60).strip() : phrase);
    }

    /** 取 anim 的 layers／sounds 陣列（沒有就是空陣列；不是陣列或太多就記錯誤） */
    private ArrayNode items(JsonNode anim, String key, List<AiError> errors) {
        JsonNode n = anim.path(key);
        if (n.isMissingNode() || n.isNull()) return json.createArrayNode();
        if (!n.isArray() || n.size() > MAX_ITEMS) {
            errors.add(schema("anim." + key + " 要是陣列、≤ " + MAX_ITEMS + " 個"));
            return json.createArrayNode();
        }
        return (ArrayNode) n;
    }

    /** 圖層／音效的 component 要是 "#n"（n 小於新插件數）或內建插件 id */
    private static void checkRefs(ArrayNode items, String key, int compCount, List<AiError> errors) {
        for (int i = 0; i < items.size(); i++) {
            JsonNode item = items.get(i);
            String ref = item.path("component").asString("");
            boolean ok = item.isObject() && REF.matcher(ref).matches() && (!ref.startsWith("#") || Integer.parseInt(ref.substring(1)) < compCount);
            if (!ok) errors.add(schema(key + "[" + i + "] 的 component 要是 \"#n\" 或內建插件 id"));
        }
    }

    /** 從回應取出第一個 JSON 物件（容忍 ```json 圍欄與前後雜訊） */
    private JsonNode jsonObject(String text) {
        String t = text == null ? "" : text.strip();
        if (t.startsWith("```")) t = FENCE.matcher(t).replaceAll("");
        JsonNode v = tryRead(t);
        if (v == null) {
            int a = t.indexOf('{');
            int b = t.lastIndexOf('}');
            if (a < 0 || b <= a) throw new AiSchemaException(List.of(new AiError("json", null, "回應不是 JSON 物件", null, null)));
            v = tryRead(t.substring(a, b + 1));
            if (v == null) throw new AiSchemaException(List.of(new AiError("json", null, "回應的 JSON 格式錯誤", null, null)));
        }
        if (!v.isObject()) throw new AiSchemaException(List.of(new AiError("json", null, "回應要是 JSON 物件", null, null)));
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
}
