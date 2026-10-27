package com.wordblade.gateway.vibe;

import com.wordblade.gateway.ai.AiError;
import com.wordblade.gateway.ai.AiSchemaException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * Vibe特效 3D 回應的解析與形狀檢查。three.js 插件是一般 JS，程式能不能跑由桌面 3D 沙盒試跑（setup＋開頭／中間／結尾三格），
 * 錯誤再回饋；這裡只擋 JSON、模式、參數定義的形狀與程式長度，並只往下傳結構化欄位（模型的自由文字丟掉）。
 */
public class Vibe3dParser {

    /** 拒答代碼 */
    static final Set<String> REFUSAL_CODES = Set.of("off-topic", "unsafe", "too-complex");
    /** 可以只填參數的內建 3D 元件 */
    static final Set<String> BUILTINS = Set.of("mascot");
    /** 參數型別 */
    static final Set<String> PARAM_TYPES = Set.of("number", "duration", "enum", "color", "boolean");
    /** 參數最多幾個 */
    static final int MAX_PARAMS = 16;
    /** 程式最多幾個字 */
    static final int MAX_CODE = 30_000;
    /** 參數名稱 */
    private static final Pattern PARAM_NAME = Pattern.compile("[A-Za-z_][A-Za-z0-9_]{0,31}");
    /** markdown 圍欄 */
    private static final Pattern FENCE = Pattern.compile("^```[a-zA-Z]*\\s*|\\s*```$");

    /**
     * 解析結果。
     *
     * @param refusal   拒答代碼；產生時為 null
     * @param mode      params（只填內建元件參數）或 new（新插件）
     * @param title     特效名稱（≤ 30 字）
     * @param builtin   mode=params 時的內建元件 id
     * @param params    mode=params 時的參數值
     * @param component mode=new 時的新插件（name、description、params、code）
     */
    public record Parsed(String refusal, String mode, String title, String builtin, ObjectNode params, ObjectNode component) {}

    private final JsonMapper json;

    public Vibe3dParser(JsonMapper json) {
        this.json = json;
    }

    /** 解析並檢查；不合格丟 AiSchemaException */
    public Parsed parse(String text) {
        JsonNode v = jsonObject(text);
        if (v.path("refused").asBoolean(false)) {
            String code = v.path("code").asString("");
            return new Parsed(REFUSAL_CODES.contains(code) ? code : "off-topic", null, "", null, null, null);
        }
        String mode = v.path("mode").asString("");
        String title = clip(v.path("title").asString("").replaceAll("[\\x00-\\x1f\\x7f]", ""), 30);
        if (mode.equals("params")) {
            String id = v.path("component").asString("");
            if (!BUILTINS.contains(id)) throw fail("component 要是內建元件 id（" + String.join("、", BUILTINS) + "）");
            JsonNode p = v.path("params");
            return new Parsed(null, mode, title, id, p.isObject() ? (ObjectNode) p : json.createObjectNode(), null);
        }
        if (!mode.equals("new")) throw fail("mode 只能是 params 或 new");
        JsonNode c = v.path("component");
        if (!c.isObject()) throw fail("component 要是物件");
        List<AiError> errors = new ArrayList<>();
        ObjectNode out = json.createObjectNode();
        out.put("name", clip(c.path("name").asString("Effect"), 40));
        out.put("description", clip(c.path("description").asString(""), 160));
        JsonNode params = c.path("params");
        ObjectNode outParams = out.putObject("params");
        if (!params.isMissingNode() && !params.isObject()) errors.add(schema("component.params 要是物件"));
        else if (params.isObject()) {
            if (params.size() > MAX_PARAMS) errors.add(schema("component.params 最多 " + MAX_PARAMS + " 個"));
            for (Map.Entry<String, JsonNode> e : params.properties()) {
                String type = e.getValue().path("type").asString("");
                if (!PARAM_NAME.matcher(e.getKey()).matches()) errors.add(schema("參數名稱「" + e.getKey() + "」只能用英數與底線"));
                else if (!PARAM_TYPES.contains(type)) errors.add(schema("參數 " + e.getKey() + " 的型別只能是 number、duration、enum、color、boolean"));
                else outParams.set(e.getKey(), e.getValue());
            }
        }
        JsonNode code = c.path("code");
        String src;
        if (code.isArray()) {
            List<String> lines = new ArrayList<>();
            code.forEach(line -> lines.add(line.asString("")));
            src = String.join("\n", lines);
        } else src = code.asString("");
        if (src.isBlank()) errors.add(schema("component.code 是空的"));
        else if (src.length() > MAX_CODE) errors.add(schema("component.code 超過 " + MAX_CODE + " 字"));
        out.put("code", src);
        if (!errors.isEmpty()) throw new AiSchemaException(errors);
        return new Parsed(null, mode, title.isEmpty() ? out.get("name").asString() : title, null, null, out);
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

    /** 截到 n 個字 */
    private static String clip(String s, int n) {
        return s.codePointCount(0, s.length()) > n ? s.substring(0, s.offsetByCodePoints(0, n)) : s;
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
