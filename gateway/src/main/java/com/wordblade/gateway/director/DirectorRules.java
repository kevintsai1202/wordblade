package com.wordblade.gateway.director;

import com.wordblade.gateway.ai.AiError;
import com.wordblade.gateway.sam.SamPhrase;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import tools.jackson.databind.JsonNode;

/**
 * AI 導演剪輯腳本的檢查（spec §5.11；docs/plan-10-29-director2.md、docs/plan-10-30-director3.md）：
 * Muse Wonder 回的 {"treatment":{…}, "chapters":[…], "items":[…]} → 導演構想＋章節＋合格的項目＋要回饋的錯誤。
 * 規則：
 * - 每項都要有目的（purpose）；剪、放大、特效、轉場、吉祥物要引用對應的旁白（quote）。
 * - 畫面類（放大、特效、轉場、吉祥物）要用 problem 指名導演構想裡的一個問題（觀眾看不清、會分心的地方）；構想沒給就沿用上一輪的問題。
 * - 風格（plain／light／playful）決定能用哪些種類；plain 只有剪、改字、遮罩、放大、字幕樣式、片頭。
 * - 放大至少 6 秒，兩次放大之間至少隔 5 秒（不要一句話放大一次）。
 * - 時間夾在片長內；各種類必填欄位（遮罩的名詞片語、轉場的場景、改字的詞 id、放大的活動區或框、吉祥物的目標框、字幕樣式、配樂描述、片頭標題）。
 * - 3D 轉場只能在章節交界（離某個章節起點 3 秒內）、長 2～6 秒、最多 3 個、彼此相隔 30 秒；特效每 20 秒最多 1 個、整支最多 5 個；吉祥物最多 1 次。
 * - 畫面類（放大、特效、轉場、吉祥物）彼此不重疊；剪的重疊取聯集；改字以詞為準。
 * 舊名稱 camera 當作 transition。前端 src/director/suggestions.ts 的 clampSuggestions 再做一次簡化版檢查。
 */
public final class DirectorRules {

    /** 審查結果（keep：通過；revised：依審查意見改過；added：審查後補的；prune：審查員認為可有可無、預設不勾；drop：刪掉；null：還沒審查） */
    public record Review(String verdict, String note) {}

    /** 一個合格的項目（素材時間）；reason 和 purpose 相同（舊版介面讀 reason）；problem 是它解決的構想問題 id（畫面類才有） */
    public record Suggestion(String id, String kind, double start, double end, String reason, Map<String, Object> payload,
                             String purpose, String quote, int chapter, Review review, String problem) {
        Suggestion withReview(Review r) {
            return new Suggestion(id, kind, start, end, reason, payload, purpose, quote, chapter, r, problem);
        }

        Suggestion withEnd(double e) {
            return new Suggestion(id, kind, start, e, reason, payload, purpose, quote, chapter, review, problem);
        }
    }

    /** 章節（素材時間） */
    public record Chapter(String title, double start, double end) {}

    /**
     * 檢查結果。
     *
     * @param treatment  導演構想原文（觀眾、每章帶走的事、問題清單）；沒給是 null
     * @param problemIds 這一輪可引用的問題 id（構想的；沒給就是沿用的）
     */
    public record Result(List<Chapter> chapters, List<Suggestion> suggestions, List<AiError> errors, JsonNode treatment, Set<String> problemIds) {}

    /**
     * 檢查選項。
     *
     * @param style            風格 plain／light／playful（null 或不認得當 plain）
     * @param fallbackProblems 上一輪構想的問題 id（格式修正或審查後重寫時，模型可能漏掉構想）
     */
    public record Options(String style, Set<String> fallbackProblems) {}

    /** 各風格能用的種類：plain 給螢幕教學片（預設），light 加 2D 特效與配樂，playful 再加 3D 轉場與吉祥物 */
    static final Map<String, Set<String>> STYLES = Map.of(
            "plain", Set.of("cut", "fix", "mask", "zoom", "captionStyle", "intro"),
            "light", Set.of("cut", "fix", "mask", "zoom", "captionStyle", "intro", "effect", "music"),
            "playful", Set.of("cut", "fix", "mask", "zoom", "captionStyle", "intro", "effect", "music", "transition", "mascot"));

    /** 風格名稱正規化：null 或不認得當 plain */
    public static String style(String style) {
        return style != null && STYLES.containsKey(style) ? style : "plain";
    }

    /** 這個風格能用的種類 */
    public static Set<String> allowedKinds(String style) {
        return STYLES.get(style(style));
    }

    /** 各種類最多幾項 */
    static final Map<String, Integer> CAPS = Map.ofEntries(
            Map.entry("cut", 20), Map.entry("mask", 15), Map.entry("fix", 30), Map.entry("zoom", 10), Map.entry("effect", 5),
            Map.entry("transition", 3), Map.entry("mascot", 1), Map.entry("captionStyle", 1), Map.entry("music", 1), Map.entry("intro", 1));
    /** 全部最多幾項 */
    static final int TOTAL = 80;
    /** 要引用旁白的種類 */
    private static final Set<String> NEEDS_QUOTE = Set.of("cut", "zoom", "effect", "transition", "mascot");
    /** 畫面類（彼此不重疊） */
    private static final Set<String> VISUAL = Set.of("zoom", "effect", "transition", "mascot");
    /** 整體項目（時間由規則決定） */
    private static final Set<String> GLOBAL = Set.of("captionStyle", "music", "intro");
    /** 字幕樣式的逐字高亮選項 */
    private static final Set<String> KARAOKE = Set.of("off", "fill", "scale", "box");
    /** 最短幾秒 */
    private static final double MIN_LENGTH = 0.1;
    /** 轉場離章節起點多近算在交界（秒） */
    static final double BOUNDARY = 3;
    /** 特效密度：每這麼多秒最多 1 個 */
    static final double EFFECT_WINDOW = 20;
    /** 轉場彼此至少相隔幾秒 */
    static final double TRANSITION_GAP = 30;
    /** 放大最短幾秒（放大後要維持住，讓觀眾看清楚） */
    static final double ZOOM_MIN = 6;
    /** 兩次放大之間至少隔幾秒（不要放大、拉回、又放大） */
    static final double ZOOM_GAP = 5;

    private DirectorRules() {}

    /** 檢查 Wonder 的剪輯腳本（所有種類都能用、沒有沿用的問題） */
    public static Result check(JsonNode root, double duration, Set<String> scenes, Set<String> wordIds, Set<String> activities) {
        return check(root, duration, scenes, wordIds, activities, new Options("playful", Set.of()));
    }

    /**
     * 檢查 Wonder 的剪輯腳本。
     *
     * @param scenes     可用的 3D 場景 id
     * @param wordIds    送出去的詞 id（改字用）
     * @param activities 畫面變化區的 id（放大用）
     * @param options    風格與沿用的問題 id
     */
    public static Result check(JsonNode root, double duration, Set<String> scenes, Set<String> wordIds, Set<String> activities, Options options) {
        List<AiError> errors = new ArrayList<>();
        JsonNode list = root == null ? null : root.path("items");
        if (root == null || !root.isObject() || !list.isArray()) {
            errors.add(error("The response must be a JSON object with \"treatment\", \"chapters\" and \"items\"."));
            return new Result(List.of(), List.of(), errors, null, options.fallbackProblems());
        }
        List<Chapter> chapters = chapters(root.path("chapters"), duration);
        if (chapters.isEmpty()) errors.add(error("\"chapters\" must list the video's sections (title, start, end), at least one."));
        // 導演構想的問題 id；這一輪沒給就沿用上一輪的
        JsonNode treatment = root.path("treatment").isObject() ? root.path("treatment") : null;
        Set<String> problems = new TreeSet<>();
        if (treatment != null) treatment.path("problems").forEach(p -> {
            String pid = p.path("id").asString("").strip();
            if (!pid.isEmpty()) problems.add(pid);
        });
        if (problems.isEmpty()) problems.addAll(options.fallbackProblems());
        String style = style(options.style());
        Set<String> allowed = allowedKinds(style);

        List<Suggestion> ok = new ArrayList<>();
        for (int i = 0; i < list.size(); i++) {
            JsonNode s = list.get(i);
            String kind = s.path("kind").asString("");
            if (kind.equals("camera")) kind = "transition";
            String id = s.path("id").asString("").strip();
            if (id.isEmpty()) id = "i" + (i + 1);
            String where = "items[" + i + "] (" + id + ")";
            if (!CAPS.containsKey(kind)) {
                errors.add(error(where + ": unknown kind \"" + kind + "\" (use " + String.join(", ", new TreeSet<>(allowed)) + ")."));
                continue;
            }
            if (!allowed.contains(kind)) {
                errors.add(error(where + ": " + kind + " is not allowed in the \"" + style + "\" style — drop it."));
                continue;
            }
            String purpose = s.path("purpose").asString("").strip();
            String quote = s.path("quote").asString("").strip();
            if (purpose.isEmpty()) {
                errors.add(error(where + ": every item needs a \"purpose\" — say why the edit helps the viewer; drop it if you can't."));
                continue;
            }
            if (NEEDS_QUOTE.contains(kind) && quote.isEmpty()) {
                errors.add(error(where + ": " + kind + " needs \"quote\" — the transcript sentence it belongs to."));
                continue;
            }
            // 畫面類要說它解決構想裡的哪個問題；剪、改字、遮罩本身就有理由，不用
            String problem = null;
            if (VISUAL.contains(kind)) {
                problem = s.path("problem").asString("").strip();
                if (problems.isEmpty()) {
                    errors.add(error(where + ": " + kind + " needs \"problem\", but there is no \"treatment\" with problems — write the treatment first."));
                    continue;
                }
                if (!problems.contains(problem)) {
                    errors.add(error(where + ": " + kind + " needs \"problem\": the id of the treatment problem it solves (" + String.join(", ", problems) + "); if it solves none, drop it."));
                    continue;
                }
            }
            double start = Math.max(0, s.path("start").asDouble(Double.NaN));
            double end = Math.min(duration, s.path("end").asDouble(Double.NaN));
            if (GLOBAL.contains(kind)) {
                // 字幕樣式整支；配樂從 start 到片尾；片頭在開頭
                if (kind.equals("captionStyle")) { start = 0; end = duration; }
                if (kind.equals("music")) { start = Double.isNaN(start) ? 0 : Math.min(start, duration - MIN_LENGTH); end = duration; }
                if (kind.equals("intro")) { start = 0; end = Math.min(duration, 1); }
            }
            if (Double.isNaN(start) || Double.isNaN(end) || end - start < MIN_LENGTH) {
                errors.add(error(where + ": start/end must be seconds inside the video (0 to " + duration + ") with end > start."));
                continue;
            }
            Map<String, Object> payload = new LinkedHashMap<>();
            String bad = fields(kind, s, payload, scenes, wordIds, activities, start, end, chapters);
            if (bad != null) {
                errors.add(error(where + ": " + bad));
                continue;
            }
            int chapter = s.path("chapter").asInt(-1);
            ok.add(new Suggestion(id, kind, start, end, purpose, payload, purpose, quote, chapter, null, problem));
        }
        return new Result(chapters, merge(ok, errors), errors, treatment, Set.copyOf(problems));
    }

    /** 章節：夾在片長內、依起點排序、去掉空的 */
    private static List<Chapter> chapters(JsonNode list, double duration) {
        List<Chapter> out = new ArrayList<>();
        list.forEach(c -> {
            String title = c.path("title").asString("").strip();
            double start = Math.max(0, c.path("start").asDouble(Double.NaN));
            double end = Math.min(duration, c.path("end").asDouble(Double.NaN));
            if (!title.isEmpty() && !Double.isNaN(start) && !Double.isNaN(end) && end > start) out.add(new Chapter(title, start, end));
        });
        out.sort(Comparator.comparingDouble(Chapter::start));
        return out;
    }

    /** 各種類的欄位：放進 payload，不合格回錯誤說明 */
    private static String fields(String kind, JsonNode s, Map<String, Object> payload, Set<String> scenes, Set<String> wordIds,
                                 Set<String> activities, double start, double end, List<Chapter> chapters) {
        return switch (kind) {
            case "cut" -> null;
            case "mask" -> {
                String target = s.path("target").asString("").strip();
                payload.put("target", target);
                // 框（選填）：螢幕上的文字（金鑰、Email）SAM 分割不出來，前端改用這個框遮
                double[] box = box(s);
                if (box != null) putBox(payload, box);
                yield SamPhrase.valid(target) ? null : "target must be a short English noun phrase for SAM (e.g. \"API key\", \"human face\").";
            }
            case "fix" -> {
                List<String> ids = new ArrayList<>();
                s.path("wordIds").forEach(n -> ids.add(n.asString("")));
                payload.put("wordIds", ids);
                String t = text(s, "text", payload);
                yield ids.isEmpty() || !wordIds.containsAll(ids) ? "wordIds must be ids of the transcript words you were given." : t;
            }
            case "zoom" -> {
                if (end - start < ZOOM_MIN) yield "a zoom lasts at least " + (int) ZOOM_MIN + " seconds — zoom in, hold while the viewer reads, then pull out.";
                String activity = s.path("activity").asString("").strip();
                if (!activity.isEmpty()) {
                    payload.put("activity", activity);
                    yield activities.contains(activity) ? null : "activity \"" + activity + "\" is not one of the listed screen activity ids.";
                }
                String bad = null;
                for (String k : List.of("cx", "cy", "w")) {
                    double v = s.path(k).asDouble(Double.NaN);
                    if (Double.isNaN(v) || v < 0 || v > 1) bad = "zoom needs an \"activity\" id, or cx, cy and w as numbers from 0 to 1.";
                    payload.put(k, v);
                }
                yield bad;
            }
            case "effect" -> {
                double[] box = box(s);
                if (box != null) putBox(payload, box);
                yield text(s, "description", payload);
            }
            case "transition" -> {
                String scene = s.path("scene").asString("");
                payload.put("scene", scene);
                if (s.has("fromChapter")) payload.put("fromChapter", s.path("fromChapter").asInt());
                if (s.has("toChapter")) payload.put("toChapter", s.path("toChapter").asInt());
                if (!scenes.contains(scene)) yield "scene \"" + scene + "\" is not one of the listed scenes.";
                if (end - start < 2 || end - start > 6) yield "a transition lasts 2 to 6 seconds.";
                boolean atBoundary = chapters.stream().skip(1).anyMatch(c -> Math.abs(c.start() - start) <= BOUNDARY || Math.abs(c.start() - (start + end) / 2) <= BOUNDARY);
                yield atBoundary ? null : "a transition must sit at a chapter boundary (within " + (int) BOUNDARY + " s of a chapter's start, other than the first).";
            }
            case "mascot" -> {
                double[] box = box(s);
                String action = s.path("action").asString("point");
                payload.put("action", action.equals("wave") ? "wave" : "point");
                if (box == null) yield "a mascot needs the target box x, y, w, h (fractions of the frame) it points at.";
                putBox(payload, box);
                yield null;
            }
            case "captionStyle" -> {
                String k = s.path("karaoke").asString("");
                payload.put("karaoke", k);
                yield KARAOKE.contains(k) ? null : "karaoke must be one of off, fill, scale, box.";
            }
            case "music" -> text(s, "description", payload);
            case "intro" -> {
                String title = s.path("title").asString("").strip();
                payload.put("title", title);
                payload.put("subtitle", s.path("subtitle").asString("").strip());
                yield title.isEmpty() || title.length() > 40 ? "intro needs a title of at most 40 characters." : null;
            }
            default -> "unknown kind";
        };
    }

    /** 框 x、y、w、h（0～1）；缺或不合理回 null */
    private static double[] box(JsonNode s) {
        double[] b = new double[4];
        String[] keys = {"x", "y", "w", "h"};
        for (int k = 0; k < 4; k++) {
            b[k] = s.path(keys[k]).asDouble(Double.NaN);
            if (Double.isNaN(b[k]) || b[k] < 0 || b[k] > 1) return null;
        }
        return b[2] > 0 && b[3] > 0 ? b : null;
    }

    private static void putBox(Map<String, Object> payload, double[] b) {
        payload.put("x", b[0]);
        payload.put("y", b[1]);
        payload.put("w", b[2]);
        payload.put("h", b[3]);
    }

    /** 必填文字欄位：放進 payload，空的回錯誤 */
    private static String text(JsonNode s, String key, Map<String, Object> payload) {
        String v = s.path(key).asString("").strip();
        payload.put(key, v);
        return v.isEmpty() ? key + " is required." : null;
    }

    /** 同種重疊的合併、畫面類不重疊、密度與上限、依時間排序 */
    private static List<Suggestion> merge(List<Suggestion> list, List<AiError> errors) {
        List<Suggestion> sorted = new ArrayList<>(list);
        sorted.sort(Comparator.comparingDouble(Suggestion::start));
        List<Suggestion> out = new ArrayList<>();
        Map<String, Integer> count = new LinkedHashMap<>();
        for (Suggestion s : sorted) {
            String where = s.id() + " (" + s.kind() + ")";
            if (s.kind().equals("fix")) {
                if (out.stream().anyMatch(o -> o.kind().equals("fix") && o.payload().get("wordIds").equals(s.payload().get("wordIds")))) continue;
            } else if (s.kind().equals("cut") || s.kind().equals("mask")) {
                Suggestion prev = out.stream().filter(o -> o.kind().equals(s.kind()) && s.start() < o.end()).findFirst().orElse(null);
                if (prev != null) {
                    // 剪取聯集；遮罩留先出現的
                    if (s.kind().equals("cut")) out.set(out.indexOf(prev), prev.withEnd(Math.max(prev.end(), s.end())));
                    continue;
                }
            } else if (VISUAL.contains(s.kind())) {
                Suggestion clash = out.stream().filter(o -> VISUAL.contains(o.kind()) && s.start() < o.end() && o.start() < s.end()).findFirst().orElse(null);
                if (clash != null) {
                    errors.add(error(where + " overlaps " + clash.id() + " (" + clash.kind() + "); zooms, effects, transitions and the mascot must not overlap."));
                    continue;
                }
                if (s.kind().equals("effect") && out.stream().anyMatch(o -> o.kind().equals("effect") && s.start() - o.start() < EFFECT_WINDOW)) {
                    errors.add(error(where + ": at most one effect per " + (int) EFFECT_WINDOW + " seconds."));
                    continue;
                }
                if (s.kind().equals("zoom") && out.stream().anyMatch(o -> o.kind().equals("zoom") && s.start() - o.end() < ZOOM_GAP)) {
                    errors.add(error(where + ": zooms must be at least " + (int) ZOOM_GAP + " seconds apart — extend the earlier zoom instead."));
                    continue;
                }
                if (s.kind().equals("transition") && out.stream().anyMatch(o -> o.kind().equals("transition") && s.start() - o.start() < TRANSITION_GAP)) {
                    errors.add(error(where + ": transitions must be at least " + (int) TRANSITION_GAP + " seconds apart."));
                    continue;
                }
            }
            if (count.getOrDefault(s.kind(), 0) >= CAPS.get(s.kind()) || out.size() >= TOTAL) {
                errors.add(error(where + ": too many " + s.kind() + " items (at most " + CAPS.get(s.kind()) + ")."));
                continue;
            }
            count.merge(s.kind(), 1, Integer::sum);
            out.add(s);
        }
        return out;
    }

    private static AiError error(String message) {
        return new AiError("schema", null, message, null, null);
    }
}
