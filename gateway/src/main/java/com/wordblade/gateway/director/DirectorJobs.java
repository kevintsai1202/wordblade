package com.wordblade.gateway.director;

import com.wordblade.gateway.ai.AiError;
import com.wordblade.gateway.ai.AiModel;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.stream.Collectors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

/**
 * AI 導演的工作（spec §5.11；docs/plan-10-29-director2.md）：
 * 1. 理解：桌面建工作（片長、段數、3D 場景）→ 逐段上傳（480p、每秒 2 格、無聲影片＋那段的詞＋本機算的畫面變化區）→ 每段交給 Muse Spark
 *    （段落報告：章節、重講、隱私、重點、畫面變化區是什麼、聽錯的詞；段內秒數）。
 * 2. 規劃：全部回來後把報告換成素材時間，交給 Muse Wonder（規劃者）寫剪輯腳本（章節＋每項附目的與引用的旁白）→ DirectorRules 檢查，
 *    不合格帶錯誤重問一次 → planned。
 * 3. 審查：桌面依各項時間截圖拼成一張縮圖總表送來 → 另一個 Muse Wonder（審查者，獨立對話與系統提示詞，只看腳本、大綱、逐字稿與總表）
 *    逐項判定 keep／revise／drop 並指出漏掉的 → 有退回或漏掉就把意見交回規劃者改一輪 → 審查刪掉的移到 removed → done。
 * 段落失敗照樣規劃（記失敗段數），全部失敗才算失敗。工作放記憶體，一小時後清掉，只有建立它的權杖看得到；影片位元組用完就丟。
 */
public class DirectorJobs {

    private static final Logger log = LoggerFactory.getLogger(DirectorJobs.class);
    /** 工作保留多久 */
    static final Duration TTL = Duration.ofHours(1);
    /** 段數上限（每段約 2 分鐘，4 小時以內） */
    static final int MAX_SEGMENTS = 120;
    /** 規劃最多幾輪（首輪＋1 次格式修正） */
    static final int MAX_ROUNDS = 2;

    /** 3D 場景（規劃者選轉場用） */
    public record Scene(String id, String name) {}

    /** 建工作 */
    public record StartRequest(String mediaName, double duration, int segments, List<Scene> scenes) {}

    /** 一個詞（素材時間） */
    public record Word(String id, double t, String text) {}

    /** 畫面變化區（桌面比對縮圖算的；素材時間、外框 0～1） */
    public record Activity(String id, double start, double end, double x, double y, double w, double h) {}

    /** 一段的資訊（素材時間）；activities 舊版桌面沒有 */
    public record SegmentMeta(double start, double end, List<Word> words, List<Activity> activities) {
        List<Activity> activityList() {
            return activities == null ? List.of() : activities;
        }
    }

    /**
     * 給桌面看的狀態。
     *
     * @param status collecting（收段落中）、planning（規劃中）、planned（等縮圖總表審查）、reviewing、done、failed、cancelled
     * @param error  失敗原因代碼（segments-failed、plan-failed）
     */
    public record View(String status, int segmentsDone, int segmentsTotal, int segmentsFailed, List<DirectorRules.Chapter> chapters,
                       List<DirectorRules.Suggestion> suggestions, List<DirectorRules.Suggestion> removed, String error) {}

    /** 看一段影片的模型（Muse Spark；RestClient 直接送 video_url） */
    @FunctionalInterface
    public interface SegmentModel {
        AiModel.Reply analyze(byte[] mp4, double length, String transcript);
    }

    /** 記用量 */
    @FunctionalInterface
    public interface UsageRecorder {
        void record(long tokenId, String model, long in, long out);
    }

    /** 找不到工作（或不是這個權杖的） */
    public static class NotFoundException extends RuntimeException {
        NotFoundException() {
            super("job not found");
        }
    }

    /** 一個工作 */
    private static final class Job {
        final long tokenId;
        final StartRequest req;
        final Instant created = Instant.now();
        /** 各段的報告（段內秒數的原文 JSON） */
        final Map<Integer, JsonNode> reports = new ConcurrentHashMap<>();
        final Map<Integer, SegmentMeta> metas = new ConcurrentHashMap<>();
        final Set<Integer> received = ConcurrentHashMap.newKeySet();
        final Set<Integer> failed = ConcurrentHashMap.newKeySet();
        /** 規劃者的對話 id（審查後改一輪要接著同一段對話） */
        final String plannerConversation = UUID.randomUUID().toString();
        volatile String status = "collecting";
        volatile String error;
        volatile List<DirectorRules.Chapter> chapters = List.of();
        volatile List<DirectorRules.Suggestion> suggestions = List.of();
        volatile List<DirectorRules.Suggestion> removed = List.of();
        volatile boolean cancelled;

        Job(long tokenId, StartRequest req) {
            this.tokenId = tokenId;
            this.req = req;
        }
    }

    private final SegmentModel spark;
    private final AiModel planner;
    private final AiModel reviewer;
    private final Executor executor;
    private final UsageRecorder usage;
    private final JsonMapper json = JsonMapper.builder().build();
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();

    /**
     * @param planner  規劃者（Muse Wonder，系統提示詞 director/plan-prompt.txt）
     * @param reviewer 審查者（Muse Wonder，另一份系統提示詞 director/review-prompt.txt、獨立對話）
     */
    public DirectorJobs(SegmentModel spark, AiModel planner, AiModel reviewer, Executor executor, UsageRecorder usage) {
        this.spark = spark;
        this.planner = planner;
        this.reviewer = reviewer;
        this.executor = executor;
        this.usage = usage;
    }

    /** 建工作；回傳工作 id */
    public String start(long tokenId, StartRequest req) {
        purge();
        if (req.segments() < 1 || req.segments() > MAX_SEGMENTS || !(req.duration() > 0)) throw new IllegalArgumentException("bad request");
        String id = UUID.randomUUID().toString();
        jobs.put(id, new Job(tokenId, req));
        return id;
    }

    /** 收一段：交給 Spark（背景）；段號不對或重複丟 IllegalArgumentException */
    public void addSegment(long tokenId, String id, int index, SegmentMeta meta, byte[] mp4) {
        Job job = own(tokenId, id);
        if (index < 0 || index >= job.req.segments() || !job.received.add(index)) throw new IllegalArgumentException("bad segment index");
        job.metas.put(index, meta);
        executor.execute(() -> analyze(job, index, meta, mp4));
    }

    /** 背景：Spark 看一段（JSON 讀不出來重試一次）；全部回來就規劃 */
    private void analyze(Job job, int index, SegmentMeta meta, byte[] mp4) {
        if (job.cancelled) return;
        StringBuilder text = new StringBuilder();
        if (!meta.activityList().isEmpty()) {
            text.append("Screen activity found by comparing frames (seconds into this video; box as fractions of the frame):\n");
            for (Activity a : meta.activityList()) {
                text.append(String.format(Locale.ROOT, "%s [%.1f–%.1f] x=%.2f y=%.2f w=%.2f h=%.2f%n",
                        a.id(), a.start() - meta.start(), a.end() - meta.start(), a.x(), a.y(), a.w(), a.h()));
            }
            text.append("\nTranscript:\n");
        }
        text.append(meta.words().stream()
                .map(w -> String.format(Locale.ROOT, "[%.1f] %s %s", w.t() - meta.start(), w.id(), w.text()))
                .collect(Collectors.joining("\n")));
        JsonNode report = null;
        for (int attempt = 0; attempt < 2 && report == null && !job.cancelled; attempt++) {
            try {
                AiModel.Reply r = spark.analyze(mp4, meta.end() - meta.start(), text.toString());
                usage.record(job.tokenId, r.model(), r.inputTokens(), r.outputTokens());
                JsonNode node = json.readTree(r.text());
                if (node.isObject()) report = node;
            } catch (RuntimeException e) {
                log.warn("director segment {} failed: {}", index, e.getMessage());
            }
        }
        if (report != null) job.reports.put(index, report);
        else job.failed.add(index);
        if (job.reports.size() + job.failed.size() == job.req.segments() && !job.cancelled) plan(job);
    }

    /** 規則檢查要用的集合：場景、詞 id、畫面變化區 id */
    private record Sets(Set<String> scenes, Set<String> words, Set<String> activities) {}

    private Sets sets(Job job) {
        Set<String> scenes = job.req.scenes() == null ? Set.of() : job.req.scenes().stream().map(Scene::id).collect(Collectors.toSet());
        Set<String> words = new HashSet<>();
        Set<String> activities = new HashSet<>();
        job.metas.values().forEach(m -> {
            m.words().forEach(w -> words.add(w.id()));
            m.activityList().forEach(a -> activities.add(a.id()));
        });
        return new Sets(scenes, words, activities);
    }

    /** 全部段落回來：報告換成素材時間 → 規劃者寫腳本 → 檢查（不合格回饋一次）→ planned */
    private void plan(Job job) {
        // 同一個工作只規劃一次（最後兩段可能同時回來）
        synchronized (job) {
            if (!job.status.equals("collecting")) return;
            job.status = "planning";
        }
        if (job.reports.isEmpty()) {
            job.error = "segments-failed";
            job.status = "failed";
            return;
        }
        try {
            DirectorRules.Result result = askPlanner(job, brief(job));
            job.chapters = result.chapters();
            job.suggestions = result.suggestions();
            job.status = job.cancelled ? "cancelled" : "planned";
        } catch (RuntimeException e) {
            log.warn("director plan failed: {}", e.getMessage());
            job.error = "plan-failed";
            job.status = job.cancelled ? "cancelled" : "failed";
            planner.forget(job.plannerConversation);
        }
    }

    /** 問規劃者（同一段對話）；格式不合格帶錯誤重問一次 */
    private DirectorRules.Result askPlanner(Job job, String message) {
        Sets s = sets(job);
        DirectorRules.Result result = null;
        for (int round = 1; round <= MAX_ROUNDS && !job.cancelled; round++) {
            AiModel.Reply r = planner.call(job.plannerConversation, message, null);
            usage.record(job.tokenId, r.model(), r.inputTokens(), r.outputTokens());
            result = DirectorRules.check(read(r.text()), job.req.duration(), s.scenes(), s.words(), s.activities());
            if (result.errors().isEmpty() || round == MAX_ROUNDS) break;
            message = feedback(result.errors());
        }
        if (result == null) throw new IllegalStateException("cancelled");
        return result;
    }

    private JsonNode read(String text) {
        try {
            return json.readTree(text);
        } catch (RuntimeException e) {
            return null;
        }
    }

    /**
     * 審查（桌面送縮圖總表；沒有圖也可以，只看文字）：審查者獨立對話 → 有退回或漏掉就交回規劃者改一輪 → done。
     * 還沒規劃完（或已審查過）丟 IllegalArgumentException。
     */
    public void review(long tokenId, String id, AiModel.Image sheet) {
        Job job = own(tokenId, id);
        synchronized (job) {
            if (!job.status.equals("planned")) throw new IllegalArgumentException("not planned yet");
            job.status = "reviewing";
        }
        executor.execute(() -> runReview(job, sheet));
    }

    /** 背景：審查 → 改一輪 → 標上審查結果 */
    private void runReview(Job job, AiModel.Image sheet) {
        String conversation = UUID.randomUUID().toString();
        try {
            AiModel.Reply r = reviewer.call(conversation, reviewBrief(job, sheet != null), sheet);
            usage.record(job.tokenId, r.model(), r.inputTokens(), r.outputTokens());
            JsonNode root = read(r.text());
            Map<String, DirectorRules.Review> verdicts = new LinkedHashMap<>();
            if (root != null) root.path("verdicts").forEach(v -> {
                String verdict = v.path("verdict").asString("keep");
                verdicts.put(v.path("id").asString(""), new DirectorRules.Review(Set.of("keep", "revise", "drop").contains(verdict) ? verdict : "keep", v.path("note").asString("").strip()));
            });
            List<String> missing = new ArrayList<>();
            if (root != null) root.path("missing").forEach(m -> missing.add(String.format(Locale.ROOT, "%s at %.1f–%.1f s: %s",
                    m.path("kind").asString("item"), m.path("start").asDouble(0), m.path("end").asDouble(0), m.path("note").asString(""))));
            boolean changes = !missing.isEmpty() || verdicts.values().stream().anyMatch(v -> !v.verdict().equals("keep"));
            List<DirectorRules.Suggestion> before = job.suggestions;
            List<DirectorRules.Suggestion> after = before;
            if (changes && !job.cancelled) {
                DirectorRules.Result revised = askPlanner(job, revisionRequest(before, verdicts, missing));
                if (!revised.suggestions().isEmpty() || before.isEmpty()) {
                    after = revised.suggestions();
                    if (!revised.chapters().isEmpty()) job.chapters = revised.chapters();
                }
            }
            // 標上審查結果；審查刪掉的一律移到 removed（不管規劃者有沒有拿掉）
            Set<String> originalIds = before.stream().map(DirectorRules.Suggestion::id).collect(Collectors.toSet());
            List<DirectorRules.Suggestion> kept = new ArrayList<>();
            List<DirectorRules.Suggestion> removed = new ArrayList<>();
            for (DirectorRules.Suggestion s : after) {
                DirectorRules.Review v = verdicts.get(s.id());
                if (v != null && v.verdict().equals("drop")) continue;
                if (v == null) kept.add(s.withReview(originalIds.contains(s.id()) ? new DirectorRules.Review("keep", "") : new DirectorRules.Review("added", "Added after review")));
                else kept.add(s.withReview(v.verdict().equals("revise") ? new DirectorRules.Review("revised", v.note()) : v));
            }
            for (DirectorRules.Suggestion s : before) {
                DirectorRules.Review v = verdicts.get(s.id());
                if (v != null && v.verdict().equals("drop")) removed.add(s.withReview(v));
            }
            job.suggestions = kept;
            job.removed = removed;
            job.status = job.cancelled ? "cancelled" : "done";
        } catch (RuntimeException e) {
            // 審查失敗不影響已經有的腳本：照規劃的結果給使用者
            log.warn("director review failed: {}", e.getMessage());
            job.status = job.cancelled ? "cancelled" : "done";
        } finally {
            reviewer.forget(conversation);
            planner.forget(job.plannerConversation);
        }
    }

    /** 給規劃者的資料：片長、場景、各段報告與逐字稿（時間加上段落起點＝素材時間）、畫面變化區（加上 Spark 確認的內容） */
    private String brief(Job job) {
        ObjectNode root = json.createObjectNode();
        root.put("video", job.req.mediaName());
        root.put("duration", round1(job.req.duration()));
        ArrayNode scenes = root.putArray("scenes");
        if (job.req.scenes() != null) job.req.scenes().forEach(s -> scenes.addObject().put("id", s.id()).put("name", s.name()));
        ArrayNode segments = root.putArray("segments");
        for (int i = 0; i < job.req.segments(); i++) {
            SegmentMeta meta = job.metas.get(i);
            JsonNode report = job.reports.get(i);
            if (meta == null || report == null) continue;
            ObjectNode seg = segments.addObject();
            seg.put("start", round1(meta.start()));
            seg.put("end", round1(meta.end()));
            seg.put("summary", report.path("summary").asString(""));
            for (String key : List.of("chapters", "retakes", "privacy", "highlights")) {
                ArrayNode list = seg.putArray(key);
                report.path(key).forEach(item -> {
                    ObjectNode copy = ((ObjectNode) item).deepCopy();
                    if (item.has("start")) copy.put("start", round1(meta.start() + item.path("start").asDouble(0)));
                    if (item.has("end")) copy.put("end", round1(meta.start() + item.path("end").asDouble(0)));
                    list.add(copy);
                });
            }
            // 畫面變化區：本機算的時間與外框＋ Spark 確認是什麼、值不值得放大
            Map<String, JsonNode> confirmed = new LinkedHashMap<>();
            report.path("activities").forEach(a -> confirmed.put(a.path("id").asString(""), a));
            ArrayNode activities = seg.putArray("activities");
            for (Activity a : meta.activityList()) {
                ObjectNode o = activities.addObject();
                o.put("id", a.id()).put("start", round1(a.start())).put("end", round1(a.end()));
                o.put("x", round2(a.x())).put("y", round2(a.y())).put("w", round2(a.w())).put("h", round2(a.h()));
                JsonNode c = confirmed.get(a.id());
                if (c != null) {
                    o.put("what", c.path("what").asString(""));
                    o.put("zoom", c.path("zoom").asBoolean(false));
                }
            }
            seg.set("transcript", transcriptLines(meta.words()));
            // 聽錯的詞沒有時間：依詞 id 查那段的詞補上（第一個詞的時間～最後一個詞＋0.5 秒），規劃者照抄
            Map<String, Double> times = new LinkedHashMap<>();
            meta.words().forEach(w -> times.put(w.id(), w.t()));
            ArrayNode misheard = seg.putArray("misheard");
            report.path("misheard").forEach(item -> {
                List<Double> ts = new ArrayList<>();
                item.path("wordIds").forEach(n -> { Double t = times.get(n.asString("")); if (t != null) ts.add(t); });
                if (ts.isEmpty()) return;
                ObjectNode copy = ((ObjectNode) item).deepCopy();
                copy.put("start", round1(ts.stream().min(Double::compare).get()));
                copy.put("end", round1(ts.stream().max(Double::compare).get() + 0.5));
                misheard.add(copy);
            });
        }
        return json.writeValueAsString(root);
    }

    /** 逐字稿分行（素材時間）：句尾標點或 14 個詞換一行，「[秒] 文字」 */
    private ArrayNode transcriptLines(List<Word> words) {
        ArrayNode lines = json.createArrayNode();
        StringBuilder line = new StringBuilder();
        double lineStart = 0;
        int n = 0;
        for (Word w : words) {
            if (n == 0) lineStart = w.t();
            line.append(n == 0 ? "" : " ").append(w.text());
            n++;
            if (w.text().matches(".*[.!?。！？]$") || n >= 14) {
                lines.add(String.format(Locale.ROOT, "[%.1f] %s", lineStart, line));
                line.setLength(0);
                n = 0;
            }
        }
        if (n > 0) lines.add(String.format(Locale.ROOT, "[%.1f] %s", lineStart, line));
        return lines;
    }

    /** 給審查者的資料：大綱、腳本、逐字稿（不帶規劃者的對話） */
    private String reviewBrief(Job job, boolean hasSheet) {
        ObjectNode root = json.createObjectNode();
        root.put("duration", round1(job.req.duration()));
        root.put("contactSheet", hasSheet ? "Attached: one frame per item at its start time, labelled with the item id." : "No frames attached.");
        ArrayNode chapters = root.putArray("chapters");
        job.chapters.forEach(c -> chapters.addObject().put("title", c.title()).put("start", round1(c.start())).put("end", round1(c.end())));
        ArrayNode items = root.putArray("items");
        for (DirectorRules.Suggestion s : job.suggestions) {
            ObjectNode o = items.addObject();
            o.put("id", s.id()).put("kind", s.kind()).put("start", round1(s.start())).put("end", round1(s.end()));
            o.put("purpose", s.purpose()).put("quote", s.quote());
            s.payload().forEach((k, v) -> o.set(k, json.valueToTree(v)));
        }
        ArrayNode transcript = root.putArray("transcript");
        for (int i = 0; i < job.req.segments(); i++) {
            SegmentMeta meta = job.metas.get(i);
            if (meta != null) transcriptLines(meta.words()).forEach(transcript::add);
        }
        return json.writeValueAsString(root);
    }

    /** 交回規劃者的審查意見 */
    private static String revisionRequest(List<DirectorRules.Suggestion> items, Map<String, DirectorRules.Review> verdicts, List<String> missing) {
        StringBuilder sb = new StringBuilder("An independent reviewer checked your edit script against the transcript and the frames. Apply the notes and return the full corrected JSON. "
                + "Keep the same id for items you keep or change; remove items marked drop; give new items new ids.\n");
        for (DirectorRules.Suggestion s : items) {
            DirectorRules.Review v = verdicts.get(s.id());
            if (v != null && !v.verdict().equals("keep")) sb.append("- ").append(s.id()).append(" (").append(s.kind()).append("): ").append(v.verdict()).append(" — ").append(v.note()).append('\n');
        }
        for (String m : missing) sb.append("- missing: ").append(m).append('\n');
        return sb.toString();
    }

    private static double round1(double v) {
        return Math.round(v * 10) / 10.0;
    }

    private static double round2(double v) {
        return Math.round(v * 100) / 100.0;
    }

    /** 回饋給規劃者的格式錯誤 */
    private static String feedback(List<AiError> errors) {
        StringBuilder sb = new StringBuilder("Some items were invalid and were dropped. Return the full corrected JSON again:");
        errors.stream().limit(12).forEach(e -> sb.append("\n- ").append(e.message()));
        return sb.toString();
    }

    /** 狀態 */
    public View view(long tokenId, String id) {
        Job job = own(tokenId, id);
        return new View(job.status, job.reports.size(), job.req.segments(), job.failed.size(), job.chapters, job.suggestions, job.removed, job.error);
    }

    /** 取消 */
    public void cancel(long tokenId, String id) {
        Job job = own(tokenId, id);
        job.cancelled = true;
        if (!job.status.equals("done") && !job.status.equals("failed")) job.status = "cancelled";
        planner.forget(job.plannerConversation);
    }

    private Job own(long tokenId, String id) {
        Job job = jobs.get(id);
        if (job == null || job.tokenId != tokenId) throw new NotFoundException();
        return job;
    }

    private void purge() {
        Instant cutoff = Instant.now().minus(TTL);
        jobs.values().removeIf(j -> j.created.isBefore(cutoff));
    }

    /** 測試與診斷用：段內秒數的各段報告 */
    Map<Integer, JsonNode> reports(String id) {
        return new LinkedHashMap<>(jobs.get(id).reports);
    }
}
