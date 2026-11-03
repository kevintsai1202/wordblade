package com.wordblade.gateway.tts;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.time.Duration;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executor;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * AI 重生語音（spec §5.6，P2，2026-11-01）：桌面送要唸的文字、聲音樣本（WAV base64）與樣本的文字、速度 →
 * 背景呼叫 Fish Audio /v1/tts（即時克隆）→ 串流 WAV 重包成標準 WAV → base64。
 * Fish 的契約（原專案 transcript-review tts.py 實測 2026-07-21、09-17）：model 放 HTTP header、本體 msgpack、
 * 參考音檔是 raw bytes、標記用方括號 [break]、串流 WAV 的長度欄位是錯的（0xFFFFFFFF）要依 fmt 重包、prosody.speed 上限 1.3。
 * 長度對齊（重生一次、片段變速）由前端做。工作放記憶體，一小時後清掉，只有建立它的權杖看得到。
 */
public class TtsJobs {

    private static final Logger log = LoggerFactory.getLogger(TtsJobs.class);
    /** 要唸的文字上限（字元） */
    static final int MAX_TEXT = 2000;
    /** 聲音樣本上限（base64 解開後的位元組；90 秒 44.1 kHz 單聲道 16-bit 約 8 MB） */
    static final int MAX_SEED_BYTES = 12 * 1024 * 1024;
    /** Fish 的速度上限 */
    static final double MAX_SPEED = 1.3;
    /** 工作保留多久 */
    static final Duration TTL = Duration.ofHours(1);

    /** 請求：要唸的文字、樣本（WAV base64）、樣本裡講的文字、速度（0.5～1.3，超過夾住） */
    public record Request(String text, String seed, String seedText, double speed) {}

    /** 狀態：status（running／done／failed）、audio（標準 WAV base64）、秒數、錯誤 */
    public record View(String status, String audio, double seconds, String error) {}

    /** Fish 的呼叫（本體是要 msgpack 的 Map；回 WAV 位元組，可能是串流式標頭） */
    @FunctionalInterface
    public interface Speech {
        byte[] speak(Map<String, Object> body);
    }

    /** 記用量（route、units：次數） */
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
        volatile String audio;
        volatile double seconds;
        volatile String error;

        Job(long tokenId) {
            this.tokenId = tokenId;
        }
    }

    private final Speech fish;
    private final Executor executor;
    private final UsageRecorder usage;
    private final String model;
    private final Map<String, Job> jobs = new ConcurrentHashMap<>();

    /** @param model 記用量用的模型名（Fish 一律用 s2.1-pro-free，D32） */
    public TtsJobs(Speech fish, Executor executor, UsageRecorder usage, String model) {
        this.fish = fish;
        this.executor = executor;
        this.usage = usage;
        this.model = model;
    }

    /** 開始生成；文字空白或太長、沒有樣本、樣本文字空白（Fish 會生出長度失控的音訊）丟 IllegalArgumentException */
    public String start(long tokenId, Request req) {
        purge();
        String text = req.text() == null ? "" : req.text().strip();
        String seedText = req.seedText() == null ? "" : req.seedText().strip();
        if (text.isEmpty() || text.length() > MAX_TEXT || seedText.isEmpty() || req.seed() == null || req.seed().isEmpty()) throw new IllegalArgumentException("bad request");
        byte[] seed = Base64.getDecoder().decode(req.seed());
        if (seed.length == 0 || seed.length > MAX_SEED_BYTES) throw new IllegalArgumentException("bad seed");
        double speed = Math.max(0.5, Math.min(MAX_SPEED, req.speed() > 0 ? req.speed() : 1));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("text", text);
        body.put("references", List.of(Map.of("audio", seed, "text", seedText)));
        body.put("format", "wav");
        body.put("temperature", 0.7);
        body.put("normalize", true);
        body.put("prosody", Map.of("speed", speed));
        String id = UUID.randomUUID().toString();
        Job job = new Job(tokenId);
        jobs.put(id, job);
        executor.execute(() -> run(job, body));
        return id;
    }

    /** 背景：叫 Fish（失敗重試一次）→ 重包 WAV */
    private void run(Job job, Map<String, Object> body) {
        for (int attempt = 0; attempt < 2; attempt++) {
            try {
                byte[] wav = normalizeWav(fish.speak(body));
                usage.record(job.tokenId, "/v1/tts", model, 0, 0, 1);
                job.seconds = seconds(wav);
                job.audio = Base64.getEncoder().encodeToString(wav);
                job.status = "done";
                return;
            } catch (RuntimeException e) {
                log.warn("tts attempt {} failed: {}", attempt + 1, e.getMessage());
            }
        }
        job.error = "tts-failed";
        job.status = "failed";
    }

    /**
     * 串流式 WAV 重包成標準 WAV（同原專案 normalize_wav）：找 fmt 與 data 區塊；data 宣告的長度不可信（≥ 0xFFFFFF00 或超過實際剩餘）
     * 就取到檔尾，再依 fmt 寫一個長度正確的 44 位元組標頭。只支援 PCM；解析不了丟 IllegalStateException。
     */
    static byte[] normalizeWav(byte[] data) {
        ByteBuffer b = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN);
        if (data.length < 12 || b.getInt(0) != 0x46464952 || b.getInt(8) != 0x45564157) throw new IllegalStateException("not a WAV");
        int pos = 12;
        short channels = 0, bits = 0;
        int rate = 0;
        int start = -1, len = 0;
        while (pos + 8 <= data.length) {
            int id = b.getInt(pos);
            long size = Integer.toUnsignedLong(b.getInt(pos + 4));
            int body = pos + 8;
            if (id == 0x20746d66) { // "fmt "
                if (b.getShort(body) != 1) throw new IllegalStateException("not PCM");
                channels = b.getShort(body + 2);
                rate = b.getInt(body + 4);
                bits = b.getShort(body + 14);
            } else if (id == 0x61746164) { // "data"
                int remaining = data.length - body;
                start = body;
                len = size >= 0xFFFFFF00L || size > remaining ? remaining : (int) size;
                break;
            }
            pos = (int) Math.min(data.length, body + size + (size & 1));
        }
        if (start < 0 || channels <= 0 || rate <= 0 || bits <= 0) throw new IllegalStateException("bad WAV");
        ByteBuffer out = ByteBuffer.allocate(44 + len).order(ByteOrder.LITTLE_ENDIAN);
        int block = channels * bits / 8;
        out.putInt(0x46464952).putInt(36 + len).putInt(0x45564157);
        out.putInt(0x20746d66).putInt(16).putShort((short) 1).putShort(channels).putInt(rate).putInt(rate * block).putShort((short) block).putShort(bits);
        out.putInt(0x61746164).putInt(len);
        out.put(data, start, len);
        return out.array();
    }

    /** 標準 WAV 的秒數 */
    static double seconds(byte[] wav) {
        ByteBuffer b = ByteBuffer.wrap(wav).order(ByteOrder.LITTLE_ENDIAN);
        int channels = b.getShort(22), rate = b.getInt(24), bits = b.getShort(34), len = b.getInt(40);
        return (double) len / (rate * channels * (bits / 8));
    }

    /** 狀態 */
    public View view(long tokenId, String id) {
        Job job = jobs.get(id);
        if (job == null || job.tokenId != tokenId) throw new NotFoundException();
        return new View(job.status, job.audio, job.seconds, job.error);
    }

    private void purge() {
        Instant cutoff = Instant.now().minus(TTL);
        jobs.values().removeIf(j -> j.created.isBefore(cutoff));
    }
}
