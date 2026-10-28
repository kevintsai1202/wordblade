package com.wordblade.gateway.sam;

import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicInteger;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * SAM 3.1 遮罩工作（spec §5.3）：桌面上傳一支縮小、無聲的小檔與名詞片語 → 背景上傳到 Meta Files API（一小時到期）→
 * 讀 SAM 的串流、把逐格輸出切成行累積在工作裡 → 完成記用量（計費格數）→ 一定刪檔。桌面用游標輪詢新的行（Wonder Mesh 的閘道
 * 撐不住長時間的單一請求，遮罩一格只有幾百位元組，輪詢便宜）；取消時中止上游並刪檔。工作放記憶體，一小時後清掉，只有建立它的權杖看得到。
 */
public class SamJobs {

    private static final Logger log = LoggerFactory.getLogger(SamJobs.class);

    /** 工作保留多久 */
    static final Duration TTL = Duration.ofHours(1);

    /** 記錄用量（權杖、計費格數） */
    @FunctionalInterface
    public interface UsageRecorder {
        void record(long tokenId, long frames);
    }

    /** 找不到工作（或不是這個權杖的） */
    public static class NotFoundException extends RuntimeException {
        NotFoundException() {
            super("job not found");
        }
    }

    /** 同時進行的工作太多 */
    public static class BusyException extends RuntimeException {
        BusyException() {
            super("busy");
        }
    }

    /**
     * 給桌面看的狀態。
     *
     * @param status          running、done、failed、cancelled
     * @param lines           游標之後的逐格輸出（一格一行）
     * @param next            下次輪詢的游標
     * @param framesProcessed 計費格數（完成時才有）
     * @param error           失敗原因代碼（sam-upload、sam-upstream）
     */
    public record View(String status, List<String> lines, int next, long framesProcessed, String error) {}

    /** 一個工作 */
    private static final class Job {
        final long tokenId;
        final Instant created = Instant.now();
        final List<String> lines = new ArrayList<>();
        volatile String status = "running";
        volatile String error;
        volatile long frames;
        volatile boolean cancelled;

        Job(long tokenId) {
            this.tokenId = tokenId;
        }
    }

    private final MetaSamClient meta;
    private final Executor executor;
    private final Executor deleter;
    private final UsageRecorder usage;
    private final int maxConcurrent;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();
    /** 進行中的工作數 */
    private final AtomicInteger running = new AtomicInteger();

    /**
     * @param executor      跑工作的執行緒
     * @param deleter       刪檔用的執行緒（刪一個檔要 4～5 秒，不讓工作等它）
     * @param maxConcurrent 同時最多幾個工作（再多回忙）
     */
    public SamJobs(MetaSamClient meta, Executor executor, Executor deleter, UsageRecorder usage, int maxConcurrent) {
        this.meta = meta;
        this.executor = executor;
        this.deleter = deleter;
        this.usage = usage;
        this.maxConcurrent = maxConcurrent;
    }

    /** 開始一個工作；回傳工作 id */
    public String start(long tokenId, String prompt, byte[] mp4) {
        purge();
        if (running.incrementAndGet() > maxConcurrent) {
            running.decrementAndGet();
            throw new BusyException();
        }
        String id = UUID.randomUUID().toString();
        Job job = new Job(tokenId);
        jobs.put(id, job);
        executor.execute(() -> run(job, prompt, mp4));
        return id;
    }

    /** 背景：上傳 → 追蹤 → 記用量；不論結果都刪檔 */
    private void run(Job job, String prompt, byte[] mp4) {
        String fileId = null;
        try {
            try {
                fileId = meta.upload(mp4);
            } catch (RuntimeException e) {
                log.warn("SAM upload failed: {}", e.getMessage());
                finish(job, "failed", "sam-upload");
                return;
            }
            SamLines splitter = new SamLines();
            long frames = meta.track(fileId, prompt, delta -> {
                List<String> done = splitter.feed(delta);
                synchronized (job.lines) {
                    job.lines.addAll(done);
                }
            }, () -> job.cancelled);
            synchronized (job.lines) {
                job.lines.addAll(splitter.feed("\n"));
            }
            job.frames = frames;
            usage.record(job.tokenId, frames);
            finish(job, "done", null);
        } catch (SamCancelledException e) {
            finish(job, "cancelled", null);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            finish(job, "cancelled", null);
        } catch (RuntimeException e) {
            log.warn("SAM track failed: {}", e.getMessage());
            finish(job, job.cancelled ? "cancelled" : "failed", job.cancelled ? null : "sam-upstream");
        } finally {
            running.decrementAndGet();
            if (fileId != null) {
                String id = fileId;
                deleter.execute(() -> meta.delete(id));
            }
        }
    }

    /** 結束狀態 */
    private static void finish(Job job, String status, String error) {
        job.error = error;
        job.status = job.cancelled && status.equals("failed") ? "cancelled" : status;
    }

    /** 游標 after 之後的狀態與逐格行 */
    public View view(long tokenId, String id, int after) {
        Job job = own(tokenId, id);
        synchronized (job.lines) {
            int from = Math.max(0, Math.min(after, job.lines.size()));
            return new View(job.status, List.copyOf(job.lines.subList(from, job.lines.size())), job.lines.size(), job.frames, job.error);
        }
    }

    /** 取消（上游讀串流時每行檢查一次） */
    public void cancel(long tokenId, String id) {
        own(tokenId, id).cancelled = true;
    }

    /** 這個權杖的工作 */
    private Job own(long tokenId, String id) {
        Job job = jobs.get(id);
        if (job == null || job.tokenId != tokenId) throw new NotFoundException();
        return job;
    }

    /** 清掉過期的工作 */
    private void purge() {
        Instant cutoff = Instant.now().minus(TTL);
        jobs.values().removeIf(j -> j.created.isBefore(cutoff) && !j.status.equals("running"));
    }
}
