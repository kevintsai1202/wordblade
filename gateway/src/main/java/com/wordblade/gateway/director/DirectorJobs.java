package com.wordblade.gateway.director;

import com.wordblade.gateway.ai.AiError;
import com.wordblade.gateway.ai.AiModel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
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
 * 2. 規劃：全部回來後把報告換成素材時間，交給 Muse Wonder（規劃者）寫剪輯腳本（先寫導演構想：觀眾、每章帶走的事、觀眾會看不清或分心的問題；
 *    再寫章節＋每項附目的、引用的旁白、畫面類要指名解決哪個問題）。桌面規劃前送來的畫面總表附在第一次規劃；風格決定能用的種類。
 *    DirectorRules 檢查，不合格帶錯誤重問一次 → planned。
 * 3. 審查：桌面依各項時間截圖拼成一張縮圖總表送來 → 另一個 Muse Wonder（審查者，獨立對話與系統提示詞，只看腳本、大綱、逐字稿與總表）
 *    逐項判定 keep／revise／drop 並指出漏掉的 → 有退回或漏掉就把意見交回規劃者改一輪 → 審查刪掉的移到 removed → done。
 *    審查員另外點名「最先刪」的項目（prune）不交回規劃者，標上 prune 讓使用者預設不勾。
 * 診斷記錄（設了記錄目錄才記）：規劃者與審查員每輪的輸入、原始回覆、規則錯誤、對帳清單，寫成 <目錄>/<工作 id>.json，建立者可用 log() 取回。
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

    /**
     * 建工作；style 是風格 plain／light／playful（舊版桌面沒有，當 plain）；
     * directives 是使用者的導演指示（一條一句，依序是 d1、d2…；舊版桌面沒有）。
     */
    public record StartRequest(String mediaName, double duration, int segments, List<Scene> scenes, String style, List<String> directives) {
        /** 沒有導演指示 */
        public StartRequest(String mediaName, double duration, int segments, List<Scene> scenes, String style) {
            this(mediaName, duration, segments, scenes, style, List.of());
        }

        /** 導演指示：去掉空白的，最多 MAX_DIRECTIVES 條、每條最多 MAX_DIRECTIVE_LENGTH 字 */
        public List<String> directiveList() {
            if (directives == null) return List.of();
            return directives.stream().filter(d -> d != null && !d.isBlank()).map(String::strip)
                    .map(d -> d.length() > MAX_DIRECTIVE_LENGTH ? d.substring(0, MAX_DIRECTIVE_LENGTH) : d).limit(MAX_DIRECTIVES).toList();
        }
    }

    /** 導演指示最多幾條、每條最多幾個字 */
    static final int MAX_DIRECTIVES = 10;
    static final int MAX_DIRECTIVE_LENGTH = 300;

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
                       List<DirectorRules.Suggestion> suggestions, List<DirectorRules.Suggestion> removed, String error, JsonNode treatment) {}

    /** 看一段影片的模型（Muse Spark；RestClient 直接送 video_url） */
    @FunctionalInterface
    public interface SegmentModel {
        AiModel.Reply analyze(byte[] mp4, double length, String transcript);
    }

    /**
     * Jev 對一對句子的判斷（機率 0～1）。
     *
     * @param retake     後面重講同樣的內容（剪前面）
     * @param falseStart 前面是放棄的碎片，後面重新開始（剪前面）
     * @param supplement 後面補充前面漏講的（兩段都留，列成提醒）
     * @param complete   後面那次講完整
     */
    public record RetakeVerdict(double retake, double falseStart, double supplement, double complete, long inputTokens, String model) {
        /** 前面該剪：重講或放棄的碎片 */
        public boolean isRetake() {
            return retake >= RETAKE_THRESHOLD || falseStart >= RETAKE_THRESHOLD;
        }

        /** 後面是補充（不是重講） */
        public boolean isSupplement() {
            return !isRetake() && supplement >= RETAKE_THRESHOLD;
        }
    }

    /** 每一句講完整的機率（和送出的句子一一對應） */
    public record Completeness(List<Double> probabilities, long inputTokens, String model) {}

    /** 判斷重講候選的模型（TypeSafe Jev；System One 回機率，同樣的輸入結果穩定） */
    @FunctionalInterface
    public interface RetakeJudge {
        RetakeVerdict judge(String earlier, String later);

        /** 每一句講完整了沒有（不支援回 null：不找「不完整的句子」的候選） */
        default Completeness completeness(List<String> sentences) {
            return null;
        }
    }

    /**
     * 重講候選與 Jev 的判斷。
     *
     * @param verdict         null：沒有 Jev 或判斷失敗，未確認
     * @param earlierComplete 前面那句自己講完整的機率（NaN：不知道）
     */
    public record JudgedRetake(RetakeFinder.Candidate candidate, RetakeVerdict verdict, double earlierComplete) {
        public JudgedRetake(RetakeFinder.Candidate candidate, RetakeVerdict verdict) {
            this(candidate, verdict, Double.NaN);
        }

        /**
         * 該剪：Jev 判斷重講或放棄的碎片；前面那句不完整、後面那句又明顯比它完整（多 0.15 以上）時，碎片的門檻放寬到 0.5
         * （實測「我們要」碎片 0.55、完整度 0.06 → 後面 0.31；片尾「實是 Hello?」0.57、0.15 → 0.19 不算）。
         */
        public boolean isRetake() {
            if (verdict == null) return false;
            if (verdict.isRetake()) return true;
            return earlierComplete < INCOMPLETE && verdict.falseStart() >= FRAGMENT_THRESHOLD && verdict.complete() - earlierComplete >= FRAGMENT_MARGIN;
        }

        /** 後面是補充 */
        public boolean isSupplement() {
            return verdict != null && !isRetake() && verdict.supplement() >= RETAKE_THRESHOLD;
        }
    }

    /** Jev 判斷是重講／放棄的碎片／補充的門檻（2026-10-31 實測 probe-jev-relation.mjs 16 題全對） */
    static final double RETAKE_THRESHOLD = 0.6;
    /** 句子講完整的機率低於這個就算不完整（不完整的句子不看字面，和後面幾句配成候選） */
    static final double INCOMPLETE = 0.5;
    /** 前面那句不完整時，放棄碎片的門檻 */
    static final double FRAGMENT_THRESHOLD = 0.5;
    /** 放寬碎片門檻時，後面那句至少要比碎片完整多少 */
    static final double FRAGMENT_MARGIN = 0.15;
    /** 很確定是重講：不再看保留的那次講完整沒有（真人講課常講到一半接下一句，實測重錄那次完整度只有 0.22～0.27） */
    static final double SURE_RETAKE = 0.75;

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
        final String id;
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
        /** 規劃前桌面送的畫面總表（每個畫面變化區、每隔一段時間一格）；只附在第一次規劃 */
        volatile AiModel.Image planSheet;
        /** 導演構想（觀眾、每章帶走的事、問題清單）；最近一輪有給的 */
        volatile JsonNode treatment;
        /** 上一輪的指示對帳清單（規劃者漏給時沿用） */
        volatile JsonNode ledger;
        /** 構想的問題 id（之後幾輪模型漏給構想時沿用） */
        volatile Set<String> problemIds = Set.of();
        /** 送給規劃者的重講候選（Jev 確認過的；沒有 Jev 時是未確認的全部） */
        volatile List<JudgedRetake> retakes = List.of();
        /** 程式決定的剪（片頭、片尾空白、確認的重講；FixedCuts）與補充的提醒 */
        volatile List<DirectorRules.Suggestion> fixed = List.of();
        /** 診斷記錄：規劃者與審查員每一輪（role、message、reply、errors…）；沒設記錄目錄時是空的 */
        final List<ObjectNode> rounds = Collections.synchronizedList(new ArrayList<>());

        Job(String id, long tokenId, StartRequest req) {
            this.id = id;
            this.tokenId = tokenId;
            this.req = req;
        }
    }

    private final SegmentModel spark;
    private final AiModel planner;
    private final AiModel reviewer;
    private final Executor executor;
    private final UsageRecorder usage;
    /** 判斷重講候選（沒設 TypeSafe 金鑰時是 null，候選標成未確認） */
    private final RetakeJudge judge;
    private final JsonMapper json = JsonMapper.builder().build();
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    /** 診斷記錄的目錄（null：不記錄；Zeabur 預設不設） */
    private volatile Path logDir;

    /**
     * @param planner  規劃者（Muse Wonder，系統提示詞 director/plan-prompt.txt）
     * @param reviewer 審查者（Muse Wonder，另一份系統提示詞 director/review-prompt.txt、獨立對話）
     */
    public DirectorJobs(SegmentModel spark, AiModel planner, AiModel reviewer, Executor executor, UsageRecorder usage) {
        this(spark, planner, reviewer, executor, usage, null);
    }

    /** @param judge 判斷重講候選的 Jev（null：不判斷，候選標成未確認） */
    public DirectorJobs(SegmentModel spark, AiModel planner, AiModel reviewer, Executor executor, UsageRecorder usage, RetakeJudge judge) {
        this.spark = spark;
        this.planner = planner;
        this.reviewer = reviewer;
        this.executor = executor;
        this.usage = usage;
        this.judge = judge;
    }

    /** 建工作；回傳工作 id */
    public String start(long tokenId, StartRequest req) {
        purge();
        if (req.segments() < 1 || req.segments() > MAX_SEGMENTS || !(req.duration() > 0)) throw new IllegalArgumentException("bad request");
        String id = UUID.randomUUID().toString();
        jobs.put(id, new Job(id, tokenId, req));
        return id;
    }

    /**
     * 規劃者要看的畫面總表（每個畫面變化區一格、每隔一段時間一格，標上 id 或秒數）。
     * 要在最後一段上傳前送到（規劃在最後一段分析完時就開始）；已經開始規劃丟 IllegalArgumentException。
     */
    public void frames(long tokenId, String id, AiModel.Image sheet) {
        Job job = own(tokenId, id);
        synchronized (job) {
            if (!job.status.equals("collecting")) throw new IllegalArgumentException("already planning");
            job.planSheet = sheet;
        }
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
        // 導演指示：請 Spark 特別留意指示提到的畫面（在摘要、重點與活動區寫清楚它在哪裡、何時出現）
        List<String> directives = job.req.directiveList();
        if (!directives.isEmpty()) {
            text.append("The editor's instructions for the whole video (they may or may not concern this part). If something they mention appears in this part, "
                    + "describe where and when it is on screen in the summary and as a highlight with its box:\n");
            for (int d = 0; d < directives.size(); d++) text.append(DirectorRules.directiveId(d)).append(": ").append(directives.get(d)).append('\n');
            text.append('\n');
        }
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
            job.retakes = judgeRetakes(job);
            List<DirectorRules.Suggestion> fixed = new ArrayList<>(FixedCuts.build(allWords(job), job.req.duration(), job.retakes));
            fixed.addAll(FixedCuts.notes(job.retakes));
            job.fixed = fixed;
            DirectorRules.Result result = askPlanner(job, brief(job));
            job.chapters = result.chapters();
            job.suggestions = result.suggestions();
            job.status = job.cancelled ? "cancelled" : "planned";
            persist(job);
        } catch (RuntimeException e) {
            log.warn("director plan failed: {}", e.getMessage());
            job.error = "plan-failed";
            job.status = job.cancelled ? "cancelled" : "failed";
            record(job, failure("planner", e));
            planner.forget(job.plannerConversation);
        }
    }

    /**
     * 問規劃者（同一段對話）；格式不合格帶錯誤重問一次。
     * 畫面總表只附在整個工作的第一次呼叫；每輪記下構想與問題 id，下一輪模型漏給構想時沿用。
     */
    private DirectorRules.Result askPlanner(Job job, String message) {
        Sets s = sets(job);
        DirectorRules.Result result = null;
        for (int round = 1; round <= MAX_ROUNDS && !job.cancelled; round++) {
            AiModel.Image sheet = job.planSheet;
            job.planSheet = null;
            AiModel.Reply r = planner.call(job.plannerConversation, message, sheet);
            usage.record(job.tokenId, r.model(), r.inputTokens(), r.outputTokens());
            ObjectNode entry = entry("planner", message, sheet != null, r);
            result = DirectorRules.check(read(r.text()), job.req.duration(), s.scenes(), s.words(), s.activities(),
                    new DirectorRules.Options(job.req.style(), job.problemIds, allWords(job), confirmedRetakes(job), job.req.directiveList(), job.ledger,
                            job.fixed.stream().filter(f -> f.kind().equals("cut")).map(f -> new double[] {f.start(), f.end()}).toList()));
            // 程式決定的剪加回去（規劃者不必列、也刪不掉）
            result = new DirectorRules.Result(result.chapters(), FixedCuts.merge(job.fixed, result.suggestions()), result.errors(), result.treatment(), result.problemIds());
            if (result.treatment() != null) job.treatment = result.treatment();
            if (result.treatment() != null && result.treatment().has("directives")) job.ledger = result.treatment().path("directives");
            job.problemIds = result.problemIds();
            ArrayNode errs = entry.putArray("errors");
            result.errors().forEach(e -> errs.add(e.message()));
            if (job.ledger != null) entry.set("ledger", job.ledger);
            entry.put("kept", result.suggestions().size());
            record(job, entry);
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
            String brief = reviewBrief(job, sheet != null);
            AiModel.Reply r = reviewer.call(conversation, brief, sheet);
            usage.record(job.tokenId, r.model(), r.inputTokens(), r.outputTokens());
            record(job, entry("reviewer", brief, sheet != null, r));
            JsonNode root = read(r.text());
            Map<String, DirectorRules.Review> verdicts = new LinkedHashMap<>();
            if (root != null) root.path("verdicts").forEach(v -> {
                String verdict = v.path("verdict").asString("keep");
                verdicts.put(v.path("id").asString(""), new DirectorRules.Review(Set.of("keep", "revise", "drop").contains(verdict) ? verdict : "keep", v.path("note").asString("").strip()));
            });
            // 審查員點名「可有可無、最先刪」的項目：不交回規劃者，標成 prune 讓使用者預設不勾
            Map<String, String> prune = new LinkedHashMap<>();
            if (root != null) root.path("prune").forEach(p -> prune.put(p.path("id").asString(""), p.path("note").asString("").strip()));
            List<String> missing = new ArrayList<>();
            if (root != null) root.path("missing").forEach(m -> missing.add(String.format(Locale.ROOT, "%s at %.1f–%.1f s: %s",
                    m.path("kind").asString("item"), m.path("start").asDouble(0), m.path("end").asDouble(0), m.path("note").asString(""))));
            // 照使用者指示做的項目：不能標成可有可無；要刪改成修改交回規劃者（規劃者改不了就在對帳清單寫理由）
            Set<String> directed = job.suggestions.stream().filter(x -> x.payload().containsKey("directive")).map(DirectorRules.Suggestion::id).collect(Collectors.toSet());
            prune.keySet().removeAll(directed);
            for (Map.Entry<String, DirectorRules.Review> e : List.copyOf(verdicts.entrySet())) {
                if (directed.contains(e.getKey()) && e.getValue().verdict().equals("drop"))
                    verdicts.put(e.getKey(), new DirectorRules.Review("revise", e.getValue().note()
                            + " (The user asked for this edit: keep it and fix the problem, or remove it only with a notAdopted reason in treatment.directives.)"));
            }
            // 程式決定的剪（f 開頭）不交回規劃者：審查者要改或刪就改成 prune（預設不勾），讓使用者決定
            for (Map.Entry<String, DirectorRules.Review> e : List.copyOf(verdicts.entrySet())) {
                if (isFixed(e.getKey()) && !e.getValue().verdict().equals("keep")) {
                    verdicts.remove(e.getKey());
                    prune.put(e.getKey(), e.getValue().note());
                }
            }
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
                if (prune.containsKey(s.id())) kept.add(s.withReview(new DirectorRules.Review("prune", prune.get(s.id()))));
                else if (v == null) kept.add(s.withReview(originalIds.contains(s.id()) ? new DirectorRules.Review("keep", "") : new DirectorRules.Review("added", "Added after review")));
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
            record(job, failure("reviewer", e));
            job.status = job.cancelled ? "cancelled" : "done";
        } finally {
            persist(job);
            reviewer.forget(conversation);
            planner.forget(job.plannerConversation);
        }
    }

    /** 給規劃者的資料：片長、場景、各段報告與逐字稿（時間加上段落起點＝素材時間）、畫面變化區（加上 Spark 確認的內容） */
    private String brief(Job job) {
        ObjectNode root = json.createObjectNode();
        root.put("video", job.req.mediaName());
        root.put("duration", round1(job.req.duration()));
        putStyle(root, job);
        putDirectives(root, job);
        root.put("frames", job.planSheet != null
                ? "Attached: a contact sheet with one frame per screen activity region (labelled with its id) and frames every few seconds (labelled with the time)."
                : "No frames attached.");
        // 3D 場景只在能用轉場、吉祥物的風格才送（不送就不會被拿來裝飾）
        ArrayNode scenes = root.putArray("scenes");
        if (job.req.scenes() != null && (DirectorRules.allowedKinds(job.req.style()).contains("transition") || !job.req.directiveList().isEmpty())) job.req.scenes().forEach(s -> scenes.addObject().put("id", s.id()).put("name", s.name()));
        ArrayNode segments = root.putArray("segments");
        for (int i = 0; i < job.req.segments(); i++) {
            SegmentMeta meta = job.metas.get(i);
            JsonNode report = job.reports.get(i);
            if (meta == null || report == null) continue;
            ObjectNode seg = segments.addObject();
            seg.put("start", round1(meta.start()));
            seg.put("end", round1(meta.end()));
            seg.put("summary", report.path("summary").asString(""));
            for (String key : List.of("privacy", "highlights")) {
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
        // 程式決定的剪：規劃者不必再列，也不要剪在它們範圍內
        ArrayNode fixedCuts = root.putArray("fixedCuts");
        job.fixed.stream().filter(f -> f.kind().equals("cut")).forEach(f -> fixedCuts.addObject().put("id", f.id()).put("reason", String.valueOf(f.payload().get("reason")))
                .put("start", round1(f.start())).put("end", round1(f.end())));
        // 重講候選（本機找、Jev 判斷）：規劃者依這些決定 retake 的剪
        ArrayNode retakes = root.putArray("retakeCandidates");
        for (JudgedRetake r : job.retakes) {
            if (r.verdict() != null && !r.isRetake()) continue;
            ObjectNode o = retakes.addObject();
            RetakeFinder.Candidate c = r.candidate();
            o.put("id", c.id()).put("start", round1(c.start())).put("end", round1(c.end())).put("earlier", c.earlier()).put("later", c.later());
            o.put("verified", r.verdict() != null);
            if (r.verdict() != null) {
                o.put("retakeProbability", round2(Math.max(r.verdict().retake(), r.verdict().falseStart())));
                o.put("laterCompleteProbability", round2(r.verdict().complete()));
            }
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
        putStyle(root, job);
        putDirectives(root, job);
        if (job.treatment != null) root.set("treatment", job.treatment);
        ArrayNode chapters = root.putArray("chapters");
        job.chapters.forEach(c -> chapters.addObject().put("title", c.title()).put("start", round1(c.start())).put("end", round1(c.end())));
        ArrayNode items = root.putArray("items");
        for (DirectorRules.Suggestion s : job.suggestions) {
            ObjectNode o = items.addObject();
            o.put("id", s.id()).put("kind", s.kind()).put("start", round1(s.start())).put("end", round1(s.end()));
            o.put("purpose", s.purpose()).put("quote", s.quote());
            if (s.problem() != null) o.put("problem", s.problem());
            s.payload().forEach((k, v) -> o.set(k, json.valueToTree(v)));
        }
        ArrayNode transcript = root.putArray("transcript");
        for (int i = 0; i < job.req.segments(); i++) {
            SegmentMeta meta = job.metas.get(i);
            if (meta != null) transcriptLines(meta.words()).forEach(transcript::add);
        }
        // 剪完剩下的逐字稿：審查者檢查「剪完有沒有重複講、有沒有剪掉需要的內容」
        List<double[]> cuts = job.suggestions.stream().filter(s -> s.kind().equals("cut")).map(s -> new double[] {s.start(), s.end()})
                .sorted(java.util.Comparator.comparingDouble(c -> c[0])).toList();
        List<Word> kept = allWords(job).stream().filter(w -> cuts.stream().noneMatch(c -> w.t() >= c[0] && w.t() < c[1])).toList();
        ArrayNode remaining = root.putArray("remainingTranscript");
        int k = 0;
        List<Word> run = new ArrayList<>();
        for (Word w : kept) {
            while (k < cuts.size() && cuts.get(k)[0] <= w.t()) {
                if (!run.isEmpty()) transcriptLines(run).forEach(remaining::add);
                run = new ArrayList<>();
                remaining.add(String.format(Locale.ROOT, "[cut %.1f–%.1f]", cuts.get(k)[0], cuts.get(k)[1]));
                k++;
            }
            run.add(w);
        }
        if (!run.isEmpty()) transcriptLines(run).forEach(remaining::add);
        for (; k < cuts.size(); k++) remaining.add(String.format(Locale.ROOT, "[cut %.1f–%.1f]", cuts.get(k)[0], cuts.get(k)[1]));
        return json.writeValueAsString(root);
    }

    /**
     * 重講候選：先問 Jev 每一句講完整沒有（不完整的句子不看字面、和後面幾句配成候選），本機找候選（RetakeFinder），
     * 有 Jev 就逐一判斷，留下重講／放棄的碎片（剪）與補充（提醒）；沒有 Jev 或判斷失敗，候選標成未確認照樣送。
     * 每個候選與機率記 log，實測時查得出哪一步不穩。
     */
    private List<JudgedRetake> judgeRetakes(Job job) {
        List<Word> words = allWords(job);
        Set<Integer> incomplete = new HashSet<>();
        /** 每一句（依開始時間）講完整的機率 */
        Map<Double, Double> sentenceComplete = new java.util.HashMap<>();
        if (judge != null) {
            List<RetakeFinder.Utterance> us = RetakeFinder.utterances(words);
            try {
                Completeness c = us.isEmpty() ? null : judge.completeness(us.stream().map(u -> RetakeFinder.text(u.words())).toList());
                if (c != null) {
                    usage.record(job.tokenId, c.model(), c.inputTokens(), 0);
                    for (int i = 0; i < us.size() && i < c.probabilities().size(); i++) {
                        if (c.probabilities().get(i) < INCOMPLETE) incomplete.add(i);
                        sentenceComplete.put(us.get(i).start(), c.probabilities().get(i));
                        log.info("director sentence {} at {}s complete={}", i, round1(us.get(i).start()), round2(c.probabilities().get(i)));
                    }
                }
            } catch (RuntimeException e) {
                log.warn("completeness judge failed: {}", e.getMessage());
            }
        }
        List<JudgedRetake> out = new ArrayList<>();
        for (RetakeFinder.Candidate c : RetakeFinder.find(words, incomplete)) {
            if (job.cancelled) break;
            RetakeVerdict v = null;
            if (judge != null) {
                try {
                    v = judge.judge(c.earlier(), c.later());
                    usage.record(job.tokenId, v.model(), v.inputTokens(), 0);
                    log.info("director candidate {}–{}s sim={} retake={} falseStart={} supplement={} complete={} model={}", round1(c.start()), round1(c.end()),
                            c.similarity(), round2(v.retake()), round2(v.falseStart()), round2(v.supplement()), round2(v.complete()), v.model());
                } catch (RuntimeException e) {
                    log.warn("retake judge failed: {}", e.getMessage());
                }
            }
            JudgedRetake j = new JudgedRetake(c, v, sentenceComplete.getOrDefault(c.start(), Double.NaN));
            if (v == null || j.isRetake() || j.isSupplement()) out.add(j);
        }
        return out;
    }

    /** 程式決定的剪（id f1、f2…） */
    private static boolean isFixed(String id) {
        return id.matches("[fn]\\d+");
    }

    /** Jev 確認過的重講範圍（規則用來放行換句話說的重講） */
    private static List<double[]> confirmedRetakes(Job job) {
        return job.retakes.stream().filter(JudgedRetake::isRetake).map(r -> new double[] {r.candidate().start(), r.candidate().end()}).toList();
    }

    /** 全部段落的詞（素材時間、依時間排序）：規則檢查重講與無聲、審查看剪完剩下的 */
    private static List<Word> allWords(Job job) {
        List<Word> out = new ArrayList<>();
        job.metas.values().forEach(m -> out.addAll(m.words()));
        out.sort(java.util.Comparator.comparingDouble(Word::t));
        return out;
    }

    /** 交回規劃者的審查意見 */
    private static String revisionRequest(List<DirectorRules.Suggestion> items, Map<String, DirectorRules.Review> verdicts, List<String> missing) {
        StringBuilder sb = new StringBuilder("An independent reviewer checked your edit script against the transcript and the frames. Apply the notes and return the complete corrected JSON (treatment, chapters, items). "
                + "Keep the same id for items you keep or change; remove items marked drop; give new items new ids.\n");
        for (DirectorRules.Suggestion s : items) {
            DirectorRules.Review v = verdicts.get(s.id());
            if (v != null && !v.verdict().equals("keep")) sb.append("- ").append(s.id()).append(" (").append(s.kind()).append("): ").append(v.verdict()).append(" — ").append(v.note()).append('\n');
        }
        for (String m : missing) sb.append("- missing: ").append(m).append('\n');
        return sb.toString();
    }

    /** 資料裡寫上風格與能用的種類（規劃者只能用這些、審查者不會要求補裝飾） */
    private static void putStyle(ObjectNode root, Job job) {
        root.put("style", DirectorRules.style(job.req.style()));
        ArrayNode kinds = root.putArray("allowedKinds");
        new java.util.TreeSet<>(DirectorRules.allowedKinds(job.req.style())).forEach(kinds::add);
    }

    /** 資料裡寫上使用者的導演指示 [{id, text}]（沒有就不寫） */
    private static void putDirectives(ObjectNode root, Job job) {
        List<String> directives = job.req.directiveList();
        if (directives.isEmpty()) return;
        ArrayNode list = root.putArray("directives");
        for (int d = 0; d < directives.size(); d++) list.addObject().put("id", DirectorRules.directiveId(d)).put("text", directives.get(d));
    }

    private static double round1(double v) {
        return Math.round(v * 10) / 10.0;
    }

    private static double round2(double v) {
        return Math.round(v * 100) / 100.0;
    }

    /** 回饋給規劃者的格式錯誤 */
    private static String feedback(List<AiError> errors) {
        StringBuilder sb = new StringBuilder("Some items were invalid and were dropped. Return the complete corrected JSON again (treatment, chapters, items):");
        errors.stream().limit(12).forEach(e -> sb.append("\n- ").append(e.message()));
        return sb.toString();
    }

    /** 開始寫診斷記錄（目錄不存在就建；null 是不記錄） */
    public void logTo(Path dir) {
        logDir = dir;
    }

    /** 一輪的診斷記錄：誰、送了什麼（有沒有附圖）、原始回覆、模型與 token */
    private ObjectNode entry(String role, String message, boolean image, AiModel.Reply r) {
        ObjectNode e = json.createObjectNode();
        e.put("at", Instant.now().toString()).put("role", role).put("message", message).put("image", image)
                .put("reply", r.text()).put("model", r.model()).put("inputTokens", r.inputTokens()).put("outputTokens", r.outputTokens());
        return e;
    }

    /** 失敗的診斷記錄 */
    private ObjectNode failure(String role, RuntimeException ex) {
        ObjectNode e = json.createObjectNode();
        e.put("at", Instant.now().toString()).put("role", role).put("failed", String.valueOf(ex.getMessage()));
        return e;
    }

    /** 記下一輪並把整份記錄重寫成檔案；沒設目錄就不記，寫檔失敗只留警告（不影響工作） */
    private void record(Job job, ObjectNode entry) {
        Path dir = logDir;
        if (dir == null) return;
        job.rounds.add(entry);
        persist(job);
    }

    /** 整份記錄重寫成檔案（狀態改變後也要寫，檔案裡的 status 才是最後的） */
    private void persist(Job job) {
        Path dir = logDir;
        if (dir == null) return;
        try {
            Files.createDirectories(dir);
            Files.writeString(dir.resolve(job.id + ".json"), json.writerWithDefaultPrettyPrinter().writeValueAsString(snapshot(job)));
        } catch (Exception e) {
            log.warn("director log write failed: {}", e.getMessage());
        }
    }

    /** 整份診斷記錄：工作的輸入、程式決定的剪與重講判斷、每一輪 */
    private ObjectNode snapshot(Job job) {
        ObjectNode root = json.createObjectNode();
        root.put("id", job.id).put("created", job.created.toString()).put("status", job.status)
                .put("mediaName", job.req.mediaName()).put("duration", job.req.duration()).put("style", job.req.style());
        ArrayNode directives = root.putArray("directives");
        job.req.directiveList().forEach(directives::add);
        root.set("fixed", json.valueToTree(job.fixed));
        root.set("retakes", json.valueToTree(job.retakes));
        ArrayNode rounds = root.putArray("rounds");
        synchronized (job.rounds) {
            job.rounds.forEach(rounds::add);
        }
        return root;
    }

    /** 診斷記錄（只有建立者看得到；沒設記錄目錄時找不到） */
    public JsonNode log(long tokenId, String id) {
        Job job = own(tokenId, id);
        if (logDir == null) throw new NotFoundException();
        return snapshot(job);
    }

    /** 狀態 */
    public View view(long tokenId, String id) {
        Job job = own(tokenId, id);
        return new View(job.status, job.reports.size(), job.req.segments(), job.failed.size(), job.chapters, job.suggestions, job.removed, job.error, job.treatment);
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
