package com.wordblade.gateway.director;

import com.wordblade.gateway.ai.AiError;
import com.wordblade.gateway.sam.SamPhrase;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import tools.jackson.databind.JsonNode;

/**
 * AI 導演建議的檢查（spec §5.11；docs/plan-10-28-director.md）：Muse Wonder 回的 {"suggestions":[…]} → 合格的建議＋要回饋的錯誤。
 * 規則：時間夾在片長內、太短丟掉；各種類必填欄位（mask 的 target 要是 SAM 看得懂的英文名詞片語、camera 的 scene 要在給的清單裡、
 * fix 的 wordIds 要是送出去的詞、zoom 的 cx／cy／w 在 0～1）；同種重疊的合併（剪取聯集，其他留先出現的）；每種與總數上限。
 * 前端 src/director/suggestions.ts 的 clampSuggestions 再做一次簡化版檢查。
 */
public final class DirectorRules {

    /** 一條合格的建議（素材時間） */
    public record Suggestion(String kind, double start, double end, String reason, Map<String, Object> payload) {}

    /** 檢查結果 */
    public record Result(List<Suggestion> suggestions, List<AiError> errors) {}

    /** 各種類最多幾條 */
    static final Map<String, Integer> CAPS = Map.of("cut", 20, "mask", 15, "effect", 10, "camera", 5, "fix", 30, "zoom", 10);
    /** 全部最多幾條 */
    static final int TOTAL = 60;
    /** 最短幾秒 */
    private static final double MIN_LENGTH = 0.1;

    private DirectorRules() {}

    /** 檢查 Wonder 的回應 */
    public static Result check(JsonNode root, double duration, Set<String> scenes, Set<String> wordIds) {
        List<AiError> errors = new ArrayList<>();
        JsonNode list = root == null ? null : root.path("suggestions");
        if (root == null || !root.isObject() || list == null || !list.isArray()) {
            errors.add(error("The response must be a JSON object with a \"suggestions\" array."));
            return new Result(List.of(), errors);
        }
        List<Suggestion> ok = new ArrayList<>();
        for (int i = 0; i < list.size(); i++) {
            JsonNode s = list.get(i);
            String kind = s.path("kind").asString("");
            double start = Math.max(0, s.path("start").asDouble(Double.NaN));
            double end = Math.min(duration, s.path("end").asDouble(Double.NaN));
            String reason = s.path("reason").asString("").strip();
            String where = "suggestions[" + i + "]";
            if (!CAPS.containsKey(kind)) {
                errors.add(error(where + ": unknown kind \"" + kind + "\" (use cut, mask, effect, camera, fix or zoom)."));
                continue;
            }
            if (Double.isNaN(start) || Double.isNaN(end) || end - start < MIN_LENGTH) {
                errors.add(error(where + ": start/end must be seconds inside the video (0 to " + duration + ") with end > start."));
                continue;
            }
            Map<String, Object> payload = new LinkedHashMap<>();
            String problem = switch (kind) {
                case "cut" -> null;
                case "mask" -> {
                    String target = s.path("target").asString("").strip();
                    payload.put("target", target);
                    // 框（選填）：螢幕上的文字（金鑰、Email）SAM 分割不出來，前端改用這個框遮
                    double[] box = new double[4];
                    boolean hasBox = true;
                    String[] keys = {"x", "y", "w", "h"};
                    for (int k = 0; k < 4; k++) {
                        box[k] = s.path(keys[k]).asDouble(Double.NaN);
                        if (Double.isNaN(box[k]) || box[k] < 0 || box[k] > 1) hasBox = false;
                    }
                    if (hasBox && box[2] > 0 && box[3] > 0) for (int k = 0; k < 4; k++) payload.put(keys[k], box[k]);
                    yield SamPhrase.valid(target) ? null : "target must be a short English noun phrase for SAM (e.g. \"API key\", \"human face\").";
                }
                case "effect" -> text(s, "description", payload);
                case "camera" -> {
                    String scene = s.path("scene").asString("");
                    payload.put("scene", scene);
                    String d = text(s, "description", payload);
                    yield !scenes.contains(scene) ? "scene \"" + scene + "\" is not one of the listed scenes." : d;
                }
                case "fix" -> {
                    List<String> ids = new ArrayList<>();
                    s.path("wordIds").forEach(n -> ids.add(n.asString("")));
                    payload.put("wordIds", ids);
                    String t = text(s, "text", payload);
                    yield ids.isEmpty() || !wordIds.containsAll(ids) ? "wordIds must be ids of the transcript words you were given." : t;
                }
                case "zoom" -> {
                    String bad = null;
                    for (String k : List.of("cx", "cy", "w")) {
                        double v = s.path(k).asDouble(Double.NaN);
                        if (Double.isNaN(v) || v < 0 || v > 1) bad = "cx, cy and w must be numbers from 0 to 1.";
                        payload.put(k, v);
                    }
                    yield bad;
                }
                default -> "unknown kind";
            };
            if (problem != null) {
                errors.add(error(where + " (" + kind + "): " + problem));
                continue;
            }
            ok.add(new Suggestion(kind, start, end, reason.isEmpty() ? kind : reason, payload));
        }
        return new Result(merge(ok), errors);
    }

    /** 必填文字欄位：放進 payload，空的回錯誤 */
    private static String text(JsonNode s, String key, Map<String, Object> payload) {
        String v = s.path(key).asString("").strip();
        payload.put(key, v);
        return v.isEmpty() ? key + " is required." : null;
    }

    /** 同種重疊的合併、上限、依時間排序 */
    private static List<Suggestion> merge(List<Suggestion> list) {
        List<Suggestion> sorted = new ArrayList<>(list);
        sorted.sort(Comparator.comparingDouble(Suggestion::start));
        List<Suggestion> out = new ArrayList<>();
        Map<String, Integer> count = new LinkedHashMap<>();
        for (Suggestion s : sorted) {
            // 改字以詞為準（相鄰的兩個聽錯的詞時間會重疊，不能互相吃掉）；其他種類看時間重疊
            Suggestion prev = out.stream().filter(o -> o.kind().equals(s.kind())
                    && (s.kind().equals("fix") ? o.payload().get("wordIds").equals(s.payload().get("wordIds")) : s.start() < o.end())).findFirst().orElse(null);
            if (prev != null) {
                // 剪取聯集；其他種類留先出現的那條
                if (s.kind().equals("cut")) out.set(out.indexOf(prev), new Suggestion("cut", prev.start(), Math.max(prev.end(), s.end()), prev.reason(), prev.payload()));
                continue;
            }
            if (count.getOrDefault(s.kind(), 0) >= CAPS.get(s.kind()) || out.size() >= TOTAL) continue;
            count.merge(s.kind(), 1, Integer::sum);
            out.add(s);
        }
        return out;
    }

    private static AiError error(String message) {
        return new AiError("schema", null, message, null, null);
    }
}
