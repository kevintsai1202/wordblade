package com.wordblade.gateway.locate;

import com.wordblade.gateway.ai.AiModel;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 螢幕文字定位（遮罩，spec §5.3；開發者 2026-10-28：SAM 抓不到的帳號、密碼、金鑰、Email 等交給 Muse Spark）：
 * 桌面送一個目標與幾張畫面（寬 1280 JPEG，每秒 1 格，一次最多 8 張）→ Spark 回每格裡符合目標的文字與框 → 夾在 0～1、
 * 超出範圍的格丟掉、沒回的格當作沒有；JSON 讀不出來重問一次。輪詢工作（一批約 10～20 秒），一小時後清掉，只有建立它的權杖看得到。
 */
public class LocateJobs {

    private static final Logger log = LoggerFactory.getLogger(LocateJobs.class);
    static final Duration TTL = Duration.ofHours(1);
    /** 一個工作最多幾張 */
    static final int MAX_FRAMES = 30;

    /** 一張畫面 */
    public record Frame(double t, byte[] jpeg) {}

    /** 一個找到的項目（0～1，左上角＋寬高） */
    public record Item(String text, double x, double y, double w, double h) {}

    /** 一格的結果 */
    public record FrameResult(double t, List<Item> items) {}

    /** 狀態 */
    public record View(String status, List<FrameResult> frames, String error) {}

    /** 看畫面的模型（Muse Spark，image_url＋json_schema） */
    @FunctionalInterface
    public interface ImageModel {
        AiModel.Reply analyze(String target, List<byte[]> jpegs);
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

    private static final class Job {
        final long tokenId;
        final Instant created = Instant.now();
        volatile String status = "running";
        volatile List<FrameResult> frames = List.of();
        volatile String error;

        Job(long tokenId) {
            this.tokenId = tokenId;
        }
    }

    private final ImageModel spark;
    private final Executor executor;
    private final UsageRecorder usage;
    private final JsonMapper json = JsonMapper.builder().build();
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();

    public LocateJobs(ImageModel spark, Executor executor, UsageRecorder usage) {
        this.spark = spark;
        this.executor = executor;
        this.usage = usage;
    }

    /** 開始；目標空白、超過 100 字或多行、張數 0 或太多丟 IllegalArgumentException */
    public String start(long tokenId, String target, List<Frame> frames) {
        purge();
        String t = target == null ? "" : target.strip();
        if (t.isEmpty() || t.length() > 100 || t.contains("\n") || frames.isEmpty() || frames.size() > MAX_FRAMES) throw new IllegalArgumentException("bad request");
        String id = UUID.randomUUID().toString();
        Job job = new Job(tokenId);
        jobs.put(id, job);
        executor.execute(() -> run(job, t, frames));
        return id;
    }

    /** 背景：Spark 看畫面（讀不出來重問一次） */
    private void run(Job job, String target, List<Frame> frames) {
        List<byte[]> jpegs = frames.stream().map(Frame::jpeg).toList();
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                AiModel.Reply r = spark.analyze(target, jpegs);
                usage.record(job.tokenId, r.model(), r.inputTokens(), r.outputTokens());
                JsonNode root = json.readTree(r.text());
                if (!root.path("frames").isArray()) continue;
                job.frames = parse(root, frames);
                job.status = "done";
                return;
            } catch (RuntimeException e) {
                log.warn("locate attempt {} failed: {}", attempt + 1, e.getMessage());
            }
        }
        job.error = "invalid-response";
        job.status = "failed";
    }

    /** 回應 → 每格的項目（依送出的順序；夾在 0～1、寬高 > 0） */
    private static List<FrameResult> parse(JsonNode root, List<Frame> frames) {
        List<List<Item>> items = new ArrayList<>();
        for (int i = 0; i < frames.size(); i++) items.add(new ArrayList<>());
        root.path("frames").forEach(f -> {
            int index = f.path("index").asInt(-1);
            if (index < 0 || index >= frames.size()) return;
            f.path("items").forEach(it -> {
                double x = clamp(it.path("x").asDouble(Double.NaN));
                double y = clamp(it.path("y").asDouble(Double.NaN));
                double w = Math.min(clamp(it.path("w").asDouble(Double.NaN)), 1 - x);
                double h = Math.min(clamp(it.path("h").asDouble(Double.NaN)), 1 - y);
                if (Double.isNaN(x) || Double.isNaN(y) || !(w > 0) || !(h > 0)) return;
                items.get(index).add(new Item(it.path("text").asString(""), x, y, w, h));
            });
        });
        List<FrameResult> out = new ArrayList<>();
        for (int i = 0; i < frames.size(); i++) out.add(new FrameResult(frames.get(i).t(), items.get(i)));
        return out;
    }

    private static double clamp(double v) {
        return Double.isNaN(v) ? v : Math.max(0, Math.min(1, v));
    }

    /** 狀態 */
    public View view(long tokenId, String id) {
        Job job = jobs.get(id);
        if (job == null || job.tokenId != tokenId) throw new NotFoundException();
        return new View(job.status, job.frames, job.error);
    }

    private void purge() {
        Instant cutoff = Instant.now().minus(TTL);
        jobs.values().removeIf(j -> j.created.isBefore(cutoff));
    }
}
