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
 * AI 導演的工作（spec §5.11，docs/plan-10-28-director.md）：桌面建工作（片長、段數、3D 場景清單）→ 逐段上傳（480p、每秒 2 格、無聲影片＋那段的詞）
 * → 每段收到就交給 Muse Spark 看（段落報告：重講、隱私、值得強調的時刻、聽錯的詞；段內秒數）→ 全部回來後把報告換成素材時間交給 Muse Wonder
 * 統籌 → DirectorRules 檢查，不合格帶錯誤重問一次 → 建議。段落失敗照樣統籌（記失敗段數），全部失敗才算失敗。
 * 工作放記憶體，一小時後清掉，只有建立它的權杖看得到；影片位元組用完就丟，不留在工作裡。
 */
public class DirectorJobs {

    private static final Logger log = LoggerFactory.getLogger(DirectorJobs.class);
    /** 工作保留多久 */
    static final Duration TTL = Duration.ofHours(1);
    /** 段數上限（每段約 2 分鐘，4 小時以內） */
    static final int MAX_SEGMENTS = 120;
    /** Wonder 最多幾輪（首輪＋1 次修正） */
    static final int MAX_ROUNDS = 2;

    /** 3D 場景（Wonder 選運鏡用） */
    public record Scene(String id, String name) {}

    /** 建工作 */
    public record StartRequest(String mediaName, double duration, int segments, List<Scene> scenes) {}

    /** 一個詞（素材時間） */
    public record Word(String id, double t, String text) {}

    /** 一段的資訊（素材時間） */
    public record SegmentMeta(double start, double end, List<Word> words) {}

    /**
     * 給桌面看的狀態。
     *
     * @param status running 的兩個階段 collecting（收段落中）、planning（Wonder 統籌中）；done、failed、cancelled
     * @param error  失敗原因代碼（segments-failed、plan-failed）
     */
    public record View(String status, int segmentsDone, int segmentsTotal, int segmentsFailed, List<DirectorRules.Suggestion> suggestions, String error) {}

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
        /** 各段的報告（素材時間換算前的原文 JSON），null 表示還沒回來或失敗 */
        final Map<Integer, JsonNode> reports = new ConcurrentHashMap<>();
        final Map<Integer, SegmentMeta> metas = new ConcurrentHashMap<>();
        final Set<Integer> received = ConcurrentHashMap.newKeySet();
        final Set<Integer> failed = ConcurrentHashMap.newKeySet();
        volatile String status = "collecting";
        volatile String error;
        volatile List<DirectorRules.Suggestion> suggestions = List.of();
        volatile boolean cancelled;

        Job(long tokenId, StartRequest req) {
            this.tokenId = tokenId;
            this.req = req;
        }
    }

    private final SegmentModel spark;
    private final AiModel wonder;
    private final Executor executor;
    private final UsageRecorder usage;
    private final JsonMapper json = JsonMapper.builder().build();
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();

    public DirectorJobs(SegmentModel spark, AiModel wonder, Executor executor, UsageRecorder usage) {
        this.spark = spark;
        this.wonder = wonder;
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

    /** 背景：Spark 看一段（JSON 讀不出來重試一次）；全部回來就統籌 */
    private void analyze(Job job, int index, SegmentMeta meta, byte[] mp4) {
        if (job.cancelled) return;
        String transcript = meta.words().stream()
                .map(w -> String.format(Locale.ROOT, "[%.1f] %s %s", w.t() - meta.start(), w.id(), w.text()))
                .collect(Collectors.joining("\n"));
        JsonNode report = null;
        for (int attempt = 0; attempt < 2 && report == null && !job.cancelled; attempt++) {
            try {
                AiModel.Reply r = spark.analyze(mp4, meta.end() - meta.start(), transcript);
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

    /** 全部段落回來：報告換成素材時間 → Wonder → 檢查（不合格回饋一次） */
    private void plan(Job job) {
        // 同一個工作只統籌一次（最後兩段可能同時回來）
        synchronized (job) {
            if (!job.status.equals("collecting")) return;
            job.status = "planning";
        }
        if (job.reports.isEmpty()) {
            job.error = "segments-failed";
            job.status = "failed";
            return;
        }
        Set<String> scenes = job.req.scenes() == null ? Set.of() : job.req.scenes().stream().map(Scene::id).collect(Collectors.toSet());
        Set<String> wordIds = new HashSet<>();
        job.metas.values().forEach(m -> m.words().forEach(w -> wordIds.add(w.id())));
        String conversation = UUID.randomUUID().toString();
        String message = brief(job);
        try {
            for (int round = 1; round <= MAX_ROUNDS && !job.cancelled; round++) {
                AiModel.Reply r = wonder.call(conversation, message, null);
                usage.record(job.tokenId, r.model(), r.inputTokens(), r.outputTokens());
                JsonNode root;
                try {
                    root = json.readTree(r.text());
                } catch (RuntimeException e) {
                    root = null;
                }
                DirectorRules.Result result = DirectorRules.check(root, job.req.duration(), scenes, wordIds);
                job.suggestions = result.suggestions();
                if (result.errors().isEmpty() || round == MAX_ROUNDS) break;
                message = feedback(result.errors());
            }
            job.status = job.cancelled ? "cancelled" : "done";
        } catch (RuntimeException e) {
            log.warn("director plan failed: {}", e.getMessage());
            job.error = "plan-failed";
            job.status = job.cancelled ? "cancelled" : "failed";
        } finally {
            wonder.forget(conversation);
        }
    }

    /** 給 Wonder 的資料：片長、場景清單、各段報告（時間加上段落起點＝素材時間） */
    private String brief(Job job) {
        ObjectNode root = json.createObjectNode();
        root.put("video", job.req.mediaName());
        root.put("duration", Math.round(job.req.duration() * 10) / 10.0);
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
            for (String key : List.of("retakes", "privacy", "highlights")) {
                ArrayNode list = seg.putArray(key);
                report.path(key).forEach(item -> {
                    ObjectNode copy = ((ObjectNode) item).deepCopy();
                    if (item.has("start")) copy.put("start", round1(meta.start() + item.path("start").asDouble(0)));
                    if (item.has("end")) copy.put("end", round1(meta.start() + item.path("end").asDouble(0)));
                    list.add(copy);
                });
            }
            // 聽錯的詞沒有時間：依詞 id 查那段的詞補上（第一個詞的時間～最後一個詞＋0.5 秒），Wonder 照抄
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

    private static double round1(double v) {
        return Math.round(v * 10) / 10.0;
    }

    /** 回饋給 Wonder 的錯誤 */
    private static String feedback(List<AiError> errors) {
        StringBuilder sb = new StringBuilder("Some suggestions were invalid and were dropped. Return the full corrected JSON again:");
        errors.stream().limit(12).forEach(e -> sb.append("\n- ").append(e.message()));
        return sb.toString();
    }

    /** 狀態 */
    public View view(long tokenId, String id) {
        Job job = own(tokenId, id);
        int total = job.req.segments();
        return new View(job.status, job.reports.size(), total, job.failed.size(), job.suggestions, job.error);
    }

    /** 取消 */
    public void cancel(long tokenId, String id) {
        Job job = own(tokenId, id);
        job.cancelled = true;
        if (!job.status.equals("done") && !job.status.equals("failed")) job.status = "cancelled";
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

    /** 測試與診斷用：素材時間的各段報告 */
    Map<Integer, JsonNode> reports(String id) {
        return new LinkedHashMap<>(jobs.get(id).reports);
    }
}
