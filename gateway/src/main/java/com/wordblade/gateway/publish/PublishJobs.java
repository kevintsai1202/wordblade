package com.wordblade.gateway.publish;

import com.wordblade.gateway.ai.AiModel;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 發佈包（spec §5.17、§5.12 縮圖）：
 * - 文字：桌面送成片逐字稿（每行帶成片時間）→ Muse Spark（json_schema）寫 3 個標題、說明、重點、章節、標籤 → 依 YouTube 上限整理長度與數量；
 *   章節時間對齊與 YouTube 章節規則在前端做（前端知道送出去的行首）。JSON 讀不出來或沒有標題重問一次。
 * - 縮圖底圖：桌面送一格畫面＋風格描述 → Muse Image edits（不畫字，標題由前端疊）→ 回 base64。
 * 兩種都是輪詢工作（Muse Image 約 30 秒），一小時後清掉，只有建立它的權杖看得到。
 */
public class PublishJobs {

    private static final Logger log = LoggerFactory.getLogger(PublishJobs.class);
    static final Duration TTL = Duration.ofHours(1);
    /** 逐字稿最多幾個字元（前端超過會先從中間截掉） */
    static final int MAX_TRANSCRIPT_CHARS = 60_000;
    /** 縮圖底圖最大幾位元組 */
    static final int MAX_IMAGE_BYTES = 6 * 1024 * 1024;
    /** 風格描述最長幾個字 */
    static final int MAX_STYLE = 300;
    /** YouTube 上限 */
    static final int MAX_TITLE = 100;
    static final int MAX_DESCRIPTION = 4000;
    static final int MAX_CHAPTER_TITLE = 60;
    static final int MAX_TAGS_TOTAL = 500;
    static final int MAX_HIGHLIGHTS = 8;
    private static final Pattern LANGUAGE = Pattern.compile("[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?");

    /** 縮圖提示詞（風格描述接在後面）；字一律不交給模型畫（會拼錯，spec §5.12） */
    static final String THUMBNAIL_PROMPT = "Turn this video frame into an eye-catching YouTube thumbnail background: punchy contrast, vivid colors, "
            + "cinematic lighting, keep the main subject recognizable, leave calm space in the lower third for a title. "
            + "Absolutely no text, letters, numbers or logos in the image.";

    /** 成片逐字稿的一行 */
    public record Line(double t, String text) {}

    /** 章節 */
    public record Chapter(double t, String title) {}

    /** 發佈包文字 */
    public record Kit(List<String> titles, String description, List<String> highlights, List<Chapter> chapters, List<String> tags) {}

    /** 文字工作的狀態 */
    public record KitView(String status, Kit kit, String error) {}

    /** 縮圖工作的狀態（image 是 base64） */
    public record ImageView(String status, String image, String mime, String error) {}

    /** Muse Image 的回覆 */
    public record ImageReply(byte[] bytes, String mime, long inputTokens, long outputTokens, String model) {}

    /** 寫發佈包的模型（Muse Spark，json_schema） */
    @FunctionalInterface
    public interface TextModel {
        AiModel.Reply write(String language, double duration, String transcript);
    }

    /** 改圖的模型（Muse Image edits） */
    @FunctionalInterface
    public interface ImageModel {
        ImageReply edit(String prompt, byte[] image, String mime);
    }

    /** 記用量（route、units：圖片張數） */
    @FunctionalInterface
    public interface UsageRecorder {
        void record(long tokenId, String route, String model, long in, long out, long units);
    }

    /** 找不到工作（或不是這個權杖的） */
    public static class NotFoundException extends RuntimeException {
        NotFoundException() {
            super("job not found");
        }
    }

    private static final class Job {
        final long tokenId;
        final Instant created = Instant.now();
        volatile String status = "running";
        volatile Object result;
        volatile String mime;
        volatile String error;

        Job(long tokenId) {
            this.tokenId = tokenId;
        }
    }

    private final TextModel spark;
    private final ImageModel image;
    private final Executor executor;
    private final UsageRecorder usage;
    private final JsonMapper json = JsonMapper.builder().build();
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();

    public PublishJobs(TextModel spark, ImageModel image, Executor executor, UsageRecorder usage) {
        this.spark = spark;
        this.image = image;
        this.executor = executor;
        this.usage = usage;
    }

    /** 秒數 → m:ss（滿一小時 h:mm:ss），和前端的章節格式一樣 */
    static String stamp(double t) {
        long s = (long) Math.floor(Math.max(0, t));
        return s >= 3600 ? "%d:%02d:%02d".formatted(s / 3600, (s % 3600) / 60, s % 60) : "%d:%02d".formatted(s / 60, s % 60);
    }

    /** 開始寫發佈包；沒有逐字稿、太長、片長不合理、語言代碼怪丟 IllegalArgumentException */
    public String startKit(long tokenId, String language, double duration, List<Line> lines) {
        purge();
        String lang = language == null ? "" : language.strip();
        if (!LANGUAGE.matcher(lang).matches() || lines == null || lines.isEmpty() || !(duration > 0) || duration > 24 * 3600) throw new IllegalArgumentException("bad request");
        StringBuilder transcript = new StringBuilder();
        for (Line l : lines) {
            String text = l.text() == null ? "" : l.text().replace('\n', ' ').strip();
            if (!text.isEmpty()) transcript.append('[').append(stamp(l.t())).append("] ").append(text).append('\n');
        }
        if (transcript.isEmpty() || transcript.length() > MAX_TRANSCRIPT_CHARS) throw new IllegalArgumentException("bad transcript");
        String id = UUID.randomUUID().toString();
        Job job = new Job(tokenId);
        jobs.put(id, job);
        executor.execute(() -> runKit(job, lang, duration, transcript.toString()));
        return id;
    }

    /** 背景：Spark 寫發佈包（讀不出來或沒有標題重問一次） */
    private void runKit(Job job, String language, double duration, String transcript) {
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                AiModel.Reply r = spark.write(language, duration, transcript);
                usage.record(job.tokenId, "/v1/ai/publish", r.model(), r.inputTokens(), r.outputTokens(), 0);
                Kit kit = parse(json.readTree(r.text()), duration);
                if (kit.titles().isEmpty()) continue;
                job.result = kit;
                job.status = "done";
                return;
            } catch (RuntimeException e) {
                log.warn("publish attempt {} failed: {}", attempt + 1, e.getMessage());
            }
        }
        job.error = "invalid-response";
        job.status = "failed";
    }

    /** 字串清單：去空白、丟空的、每個截到 maxEach、最多 maxCount 個 */
    private static List<String> strings(JsonNode arr, int maxEach, int maxCount) {
        List<String> out = new ArrayList<>();
        arr.forEach(n -> {
            String s = n.asString("").strip();
            if (!s.isEmpty() && out.size() < maxCount) out.add(cut(s, maxEach));
        });
        return out;
    }

    private static String cut(String s, int max) {
        return s.length() <= max ? s : s.substring(0, max).strip();
    }

    /** 回應 → 發佈包：截長度、章節在片長內、標籤總長 ≤ 500 */
    private static Kit parse(JsonNode root, double duration) {
        List<String> titles = strings(root.path("titles"), MAX_TITLE, 3);
        List<String> highlights = strings(root.path("highlights"), 150, MAX_HIGHLIGHTS);
        List<Chapter> chapters = new ArrayList<>();
        root.path("chapters").forEach(c -> {
            double t = c.path("t").asDouble(Double.NaN);
            String title = c.path("title").asString("").strip();
            if (t >= 0 && t < duration && !title.isEmpty()) chapters.add(new Chapter(t, cut(title, MAX_CHAPTER_TITLE)));
        });
        List<String> tags = new ArrayList<>();
        int total = 0;
        for (String tag : strings(root.path("tags"), 100, 30)) {
            if (total + tag.length() + 1 > MAX_TAGS_TOTAL) break;
            tags.add(tag);
            total += tag.length() + 1;
        }
        return new Kit(titles, cut(root.path("description").asString("").strip(), MAX_DESCRIPTION), highlights, chapters, tags);
    }

    /** 文字工作的狀態 */
    public KitView viewKit(long tokenId, String id) {
        Job job = find(tokenId, id);
        return new KitView(job.status, job.result instanceof Kit k ? k : null, job.error);
    }

    /** 開始改縮圖底圖；用途不是 thumbnail、沒有圖、圖太大、描述太長丟 IllegalArgumentException */
    public String startImage(long tokenId, String purpose, String style, byte[] bytes, String mime) {
        purge();
        String s = style == null ? "" : style.replace('\n', ' ').strip();
        if (!"thumbnail".equals(purpose) || bytes == null || bytes.length == 0 || bytes.length > MAX_IMAGE_BYTES || s.length() > MAX_STYLE
                || !("image/png".equals(mime) || "image/jpeg".equals(mime))) throw new IllegalArgumentException("bad request");
        String prompt = s.isEmpty() ? THUMBNAIL_PROMPT : THUMBNAIL_PROMPT + " Style: " + s + ".";
        String id = UUID.randomUUID().toString();
        Job job = new Job(tokenId);
        jobs.put(id, job);
        executor.execute(() -> runImage(job, prompt, bytes, mime));
        return id;
    }

    /** 背景：Muse Image 改圖（失敗重試一次） */
    private void runImage(Job job, String prompt, byte[] bytes, String mime) {
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                ImageReply r = image.edit(prompt, bytes, mime);
                usage.record(job.tokenId, "/v1/ai/image", r.model(), r.inputTokens(), r.outputTokens(), 1);
                if (r.bytes() == null || r.bytes().length == 0) continue;
                job.result = Base64.getEncoder().encodeToString(r.bytes());
                job.mime = r.mime();
                job.status = "done";
                return;
            } catch (RuntimeException e) {
                log.warn("image attempt {} failed: {}", attempt + 1, e.getMessage());
            }
        }
        job.error = "image-failed";
        job.status = "failed";
    }

    /** 縮圖工作的狀態 */
    public ImageView viewImage(long tokenId, String id) {
        Job job = find(tokenId, id);
        return new ImageView(job.status, job.result instanceof String s ? s : null, job.mime, job.error);
    }

    private Job find(long tokenId, String id) {
        Job job = jobs.get(id);
        if (job == null || job.tokenId != tokenId) throw new NotFoundException();
        return job;
    }

    private void purge() {
        Instant cutoff = Instant.now().minus(TTL);
        jobs.values().removeIf(j -> j.created.isBefore(cutoff));
    }
}
