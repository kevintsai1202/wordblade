package com.wordblade.gateway.synth;

import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.JsonNodeFactory;
import tools.jackson.databind.node.ObjectNode;

/**
 * JSON Schema 的小子集（spec §5.15、D27）：只支援宣告式音訊 schema 用到的關鍵字——type、properties、required、items、
 * minItems／maxItems、minimum／maximum、enum、pattern、anyOf、$ref（只有 #/$defs/…）。
 * 和前端 src/audio/synth/schemaLite.ts 同一套規則與錯誤文字：物件的多餘欄位直接丟掉（不算錯），其他不合回中文錯誤（帶路徑，回饋給模型）。
 * 不另外引入 JSON Schema 函式庫：常見的實作綁 Jackson 2，這個專案用 Jackson 3。
 */
public final class SchemaLite {

    /** 錯誤最多回幾則（夠回饋就好） */
    static final int MAX_ERRORS = 30;
    /** #/$defs/name 參照 */
    private static final Pattern REF = Pattern.compile("^#/\\$defs/([A-Za-z0-9_-]+)$");
    private static final JsonNodeFactory NODES = JsonNodeFactory.instance;

    /**
     * 檢查結果。
     *
     * @param value  清理過的複本（丟掉多餘欄位）
     * @param errors 錯誤；空＝合格
     */
    public record Result(JsonNode value, List<String> errors) {}

    private SchemaLite() {}

    /** 依 schema（root）的入口 ref（例如 #/$defs/sound）檢查 value */
    public static Result check(JsonNode root, String ref, JsonNode value) {
        Result r = node(root, NODES.objectNode().put("$ref", ref), value, "");
        return new Result(r.value(), r.errors().size() > MAX_ERRORS ? List.copyOf(r.errors().subList(0, MAX_ERRORS)) : r.errors());
    }

    /** 數字的顯示文字（和 JavaScript 的 String(number) 一樣：1 不顯示成 1.0） */
    static String num(double d) {
        return BigDecimal.valueOf(d).stripTrailingZeros().toPlainString();
    }

    /** 解析 #/$defs/name */
    private static JsonNode resolve(JsonNode root, String ref) {
        Matcher m = REF.matcher(ref);
        JsonNode target = m.matches() ? root.path("$defs").get(m.group(1)) : null;
        if (target == null) throw new IllegalStateException("schema 參照找不到：" + ref);
        return target;
    }

    /** 路徑的顯示文字（根節點顯示「回應」） */
    private static String label(String path) {
        return path.isEmpty() ? "回應" : path;
    }

    /** 兩個 JSON 值相等（數字比數值，和 JavaScript 的 === 一樣 4 等於 4.0） */
    private static boolean same(JsonNode a, JsonNode b) {
        if (a.isNumber() && b.isNumber()) return a.doubleValue() == b.doubleValue();
        return a.equals(b);
    }

    /** 列舉值的顯示文字 */
    private static String show(JsonNode v) {
        return v.isNumber() ? num(v.doubleValue()) : v.isString() ? v.asString() : v.toString();
    }

    /** anyOf 挑錯誤訊息用：值的形狀和這個分支對不對得上（型別相同；物件分支有 type 列舉時，值的 type 也要在列舉裡） */
    private static boolean sameShape(JsonNode root, JsonNode schema, JsonNode value) {
        JsonNode s = schema.has("$ref") ? resolve(root, schema.get("$ref").asString()) : schema;
        String type = s.path("type").asString("");
        return switch (type) {
            case "number", "integer" -> value.isNumber();
            case "string" -> value.isString();
            case "array" -> value.isArray();
            case "object" -> {
                if (!value.isObject()) yield false;
                JsonNode tag = s.path("properties").path("type").path("enum");
                if (!tag.isArray()) yield true;
                for (JsonNode t : tag) if (value.has("type") && same(t, value.get("type"))) yield true;
                yield false;
            }
            default -> true;
        };
    }

    /** 檢查一個節點；path 是目前的路徑（例如 voices[0].env） */
    private static Result node(JsonNode root, JsonNode schema, JsonNode value, String path) {
        if (schema.has("$ref")) return node(root, resolve(root, schema.get("$ref").asString()), value, path);
        if (schema.has("anyOf")) {
            // 任一分支通過就用它；都不過就回「形狀對得上」的分支裡錯得最少的
            Result best = null;
            boolean bestShape = false;
            for (JsonNode branch : schema.get("anyOf")) {
                Result r = node(root, branch, value, path);
                if (r.errors().isEmpty()) return r;
                boolean shape = sameShape(root, branch, value);
                if (best == null || (shape && !bestShape) || (shape == bestShape && r.errors().size() < best.errors().size())) {
                    best = r;
                    bestShape = shape;
                }
            }
            return best;
        }
        List<String> errors = new ArrayList<>();
        if (schema.has("enum")) {
            boolean ok = false;
            List<String> names = new ArrayList<>();
            for (JsonNode e : schema.get("enum")) {
                ok |= same(e, value);
                names.add(show(e));
            }
            if (!ok) return new Result(value, List.of(label(path) + " 只能是 " + String.join("、", names)));
        }
        String type = schema.path("type").asString("");
        switch (type) {
            case "number", "integer" -> {
                boolean integer = type.equals("integer");
                if (!value.isNumber() || !Double.isFinite(value.doubleValue()) || (integer && value.doubleValue() != Math.rint(value.doubleValue()))) {
                    return new Result(value, List.of(label(path) + " 要是" + (integer ? "整數" : "數字")));
                }
                double lo = schema.has("minimum") ? schema.get("minimum").doubleValue() : Double.NEGATIVE_INFINITY;
                double hi = schema.has("maximum") ? schema.get("maximum").doubleValue() : Double.POSITIVE_INFINITY;
                double v = value.doubleValue();
                if (v < lo || v > hi) errors.add(label(path) + " 要在 " + bound(lo) + "～" + bound(hi) + " 之間");
                return new Result(value, errors);
            }
            case "string" -> {
                if (!value.isString()) return new Result(value, List.of(label(path) + " 要是字串"));
                String pattern = schema.path("pattern").asString("");
                if (!pattern.isEmpty() && !Pattern.compile(pattern).matcher(value.asString()).find()) errors.add(label(path) + " 格式不對（" + pattern + "）");
                return new Result(value, errors);
            }
            case "boolean" -> {
                return value.isBoolean() ? new Result(value, errors) : new Result(value, List.of(label(path) + " 要是 true 或 false"));
            }
            case "array" -> {
                if (!value.isArray()) return new Result(value, List.of(label(path) + " 要是陣列"));
                if (schema.has("minItems") && value.size() < schema.get("minItems").asInt()) errors.add(label(path) + " 至少要 " + schema.get("minItems").asInt() + " 個");
                if (schema.has("maxItems") && value.size() > schema.get("maxItems").asInt()) errors.add(label(path) + " 最多 " + schema.get("maxItems").asInt() + " 個");
                ArrayNode out = NODES.arrayNode();
                for (int i = 0; i < value.size(); i++) {
                    if (!schema.has("items")) {
                        out.add(value.get(i));
                        continue;
                    }
                    Result r = node(root, schema.get("items"), value.get(i), path + "[" + i + "]");
                    errors.addAll(r.errors());
                    out.add(r.value());
                }
                return new Result(out, errors);
            }
            case "object" -> {
                if (!value.isObject()) return new Result(value, List.of(label(path) + " 要是物件"));
                for (JsonNode key : schema.path("required")) if (!value.has(key.asString())) errors.add(label(path) + " 缺少 " + key.asString());
                ObjectNode out = NODES.objectNode();
                // 只留 schema 列出的欄位（多餘欄位丟掉）
                for (Map.Entry<String, JsonNode> p : schema.path("properties").properties()) {
                    if (!value.has(p.getKey())) continue;
                    Result r = node(root, p.getValue(), value.get(p.getKey()), path.isEmpty() ? p.getKey() : path + "." + p.getKey());
                    errors.addAll(r.errors());
                    out.set(p.getKey(), r.value());
                }
                return new Result(out, errors);
            }
            default -> {
                return new Result(value, errors);
            }
        }
    }

    /** 範圍邊界的顯示文字（沒有邊界時和 JavaScript 一樣顯示 Infinity） */
    private static String bound(double d) {
        if (Double.isInfinite(d)) return d > 0 ? "Infinity" : "-Infinity";
        return num(d);
    }
}
