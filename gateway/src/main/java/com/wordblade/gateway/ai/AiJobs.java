package com.wordblade.gateway.ai;

import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * AI 工作（Vibe特效、用說的…）的共用流程：一個工作是一段對話。首輪送使用者訊息（＋截圖）→ 模型回應 → 依這個工作的規則（Spec）解析；
 * 格式不對就在閘道自動帶錯誤重問；桌面試跑不過時送回饋續跑。輪數與 token 有上限。
 * 工作放在記憶體（一小時後清掉），只有建立它的權杖看得到；模型呼叫在背景執行，桌面輪詢（Wonder Mesh 的閘道撐不住太久的單一請求）。
 *
 * @param <R> 解析後的結果型別
 */
public class AiJobs<R> {

    private static final Logger log = LoggerFactory.getLogger(AiJobs.class);

    /** 工作保留多久 */
    static final Duration TTL = Duration.ofHours(1);
    /** 截圖 data URL（只收 JPEG、PNG） */
    private static final Pattern DATA_URL = Pattern.compile("^data:(image/(?:jpeg|png));base64,([A-Za-z0-9+/=]+)$");

    /**
     * 一種工作的規則。
     *
     * @param <R> 解析後的結果型別
     */
    public interface Spec<R> {
        /** 解析模型回應；不合格丟 AiSchemaException（帶要回饋的錯誤） */
        R parse(String text);

        /** 錯誤 → 回饋給模型的文字 */
        String feedback(List<AiError> errors);

        /** 結果是拒答嗎（拒答就結束，不能再回饋） */
        boolean refused(R result);

        /** 最多幾輪 */
        int maxRounds();

        /** token 上限 */
        long tokenBudget();
    }

    /** 記錄用量（tokenId、模型、輸入與輸出 token） */
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

    /** 工作已經結束、拒答，或輪數用完，不能再回饋 */
    public static class TooManyRoundsException extends RuntimeException {
        TooManyRoundsException() {
            super("no more rounds");
        }
    }

    /**
     * 給桌面看的工作狀態。
     *
     * @param status running、done、failed
     * @param round  已經跑了幾輪
     * @param result 最新一輪的結果（done 時）
     * @param error  失敗原因代碼（invalid-response、budget、model-error）
     */
    public record View<R>(String status, int round, R result, String error) {}

    /** 一個工作的狀態（用 synchronized 保護） */
    private final class Job {
        final long tokenId;
        final Spec<R> spec;
        final Instant created = Instant.now();
        String status = "running";
        int round;
        long tokens;
        R result;
        String error;

        Job(long tokenId, Spec<R> spec) {
            this.tokenId = tokenId;
            this.spec = spec;
        }
    }

    private final AiModel model;
    private final Executor executor;
    private final UsageRecorder usage;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();

    public AiJobs(AiModel model, Executor executor, UsageRecorder usage) {
        this.model = model;
        this.executor = executor;
        this.usage = usage;
    }

    /** 開始一個工作，回傳工作 id；首輪在背景執行 */
    public String start(long tokenId, Spec<R> spec, String userText, AiModel.Image image) {
        cleanup();
        String id = UUID.randomUUID().toString();
        Job job = new Job(tokenId, spec);
        jobs.put(id, job);
        executor.execute(() -> run(id, job, userText, image));
        return id;
    }

    /** 桌面試跑不過：帶錯誤續跑下一輪 */
    public void feedback(long tokenId, String id, List<AiError> errors) {
        Job job = find(tokenId, id);
        synchronized (job) {
            if (!"done".equals(job.status) || job.result == null || job.spec.refused(job.result) || job.round >= job.spec.maxRounds()) {
                throw new TooManyRoundsException();
            }
            job.status = "running";
        }
        executor.execute(() -> run(id, job, job.spec.feedback(errors), null));
    }

    /** 工作狀態 */
    public View<R> view(long tokenId, String id) {
        Job job = find(tokenId, id);
        synchronized (job) {
            return new View<>(job.status, job.round, job.result, job.error);
        }
    }

    /** 跑一輪；回應格式不對且還有輪數就自動帶錯誤重問（不重送截圖） */
    private void run(String id, Job job, String text, AiModel.Image image) {
        String userText = text;
        AiModel.Image img = image;
        while (true) {
            AiModel.Reply reply;
            try {
                reply = model.call(id, userText, img);
            } catch (RuntimeException e) {
                log.warn("AI 工作：模型呼叫失敗（{}）", e.getClass().getSimpleName());
                finish(id, job, null, "model-error");
                return;
            }
            usage.record(job.tokenId, reply.model(), reply.inputTokens(), reply.outputTokens());
            synchronized (job) {
                job.round++;
                job.tokens += reply.inputTokens() + reply.outputTokens();
            }
            try {
                finish(id, job, job.spec.parse(reply.text()), null);
                return;
            } catch (AiSchemaException e) {
                synchronized (job) {
                    if (job.round >= job.spec.maxRounds()) { finishLocked(id, job, null, "invalid-response"); return; }
                    if (job.tokens >= job.spec.tokenBudget()) { finishLocked(id, job, null, "budget"); return; }
                }
                userText = job.spec.feedback(e.errors());
                img = null;
            }
        }
    }

    /** 結束這一輪 */
    private void finish(String id, Job job, R result, String error) {
        synchronized (job) {
            finishLocked(id, job, result, error);
        }
    }

    /** finish 的本體（呼叫端已鎖住 job）：done（有結果）或 failed（有錯誤代碼）；拒答或失敗時丟掉對話 */
    private void finishLocked(String id, Job job, R result, String error) {
        job.result = result;
        job.error = error;
        job.status = error == null ? "done" : "failed";
        boolean refused = result != null && job.spec.refused(result);
        if (error != null || refused) model.forget(id);
        log.info("AI 工作：第 {} 輪 {}（{} token）", job.round, error != null ? "失敗 " + error : refused ? "拒答" : "完成", job.tokens);
    }

    /** 找工作（別的權杖的當成不存在） */
    private Job find(long tokenId, String id) {
        Job job = id == null ? null : jobs.get(id);
        if (job == null || job.tokenId != tokenId) throw new NotFoundException();
        return job;
    }

    /** 清掉超過保留時間的工作 */
    private void cleanup() {
        Instant cutoff = Instant.now().minus(TTL);
        jobs.entrySet().removeIf(e -> {
            boolean old = e.getValue().created.isBefore(cutoff);
            if (old) model.forget(e.getKey());
            return old;
        });
    }

    /** 截圖 data URL → 圖片（格式不對當成沒附） */
    public static AiModel.Image decodeImage(String dataUrl) {
        if (dataUrl == null || dataUrl.isBlank()) return null;
        Matcher m = DATA_URL.matcher(dataUrl);
        if (!m.matches()) return null;
        try {
            return new AiModel.Image(m.group(1), Base64.getDecoder().decode(m.group(2)));
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
