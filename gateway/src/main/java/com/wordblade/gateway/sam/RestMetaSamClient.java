package com.wordblade.gateway.sam;

import java.io.BufferedReader;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ScheduledFuture;
import java.util.concurrent.TimeUnit;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.databind.json.JsonMapper;

/**
 * 呼叫 Meta 的 SAM 3.1（spec §5.3；照原專案 SamRelay 與 2026-10-28 實測 scripts/sam/probe.mjs）：
 * - 上傳：POST {base}/v1/files，multipart 自己組（purpose=user_data、expires_after[anchor]=created_at、expires_after[seconds]=3600、file）；
 *   不設 expires_after 檔案會永久保留。
 * - 追蹤：POST {base}/v1/responses，{"model":…,"stream":true,"metadata":{"mask_encoding":"one_bit"},"input":[…input_text、input_video…]}，
 *   Accept: text/event-stream；用 java.net.http 讀串流，取消或 180 秒沒有任何資料時關掉串流（readLine 才會返回）。
 * - 刪檔：DELETE {base}/v1/files/{id}（約 4～5 秒；刪後 GET 會在 404／200 之間跳，不用查詢確認）。
 */
public class RestMetaSamClient implements MetaSamClient {

    private static final Logger log = LoggerFactory.getLogger(RestMetaSamClient.class);
    /** 上游多久沒有任何資料就放棄 */
    static final Duration IDLE = Duration.ofSeconds(180);
    /** 檢查取消與閒置的間隔 */
    private static final long WATCH_MS = 2000;

    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build();
    private final ScheduledExecutorService watchdog = Executors.newSingleThreadScheduledExecutor(r -> {
        Thread t = new Thread(r, "sam-watchdog");
        t.setDaemon(true);
        return t;
    });
    private final String baseUrl;
    private final String apiKey;
    private final String model;
    private final JsonMapper json;

    /**
     * @param baseUrl Meta API 根網址（不含 /v1，例如 https://api.meta.ai）
     * @param model   SAM 模型 ID（WORDBLADE_MODEL_SAM，預設 sam-3.1）
     */
    public RestMetaSamClient(String baseUrl, String apiKey, String model, JsonMapper json) {
        this.baseUrl = baseUrl.replaceAll("/+$", "");
        this.apiKey = apiKey;
        this.model = model;
        this.json = json;
    }

    @Override
    public String upload(byte[] mp4) {
        String b = "wordblade-" + UUID.randomUUID();
        var out = new ByteArrayOutputStream(mp4.length + 1024);
        for (var f : Map.of("purpose", "user_data", "expires_after[anchor]", "created_at", "expires_after[seconds]", "3600").entrySet()) {
            out.writeBytes(("--" + b + "\r\nContent-Disposition: form-data; name=\"" + f.getKey() + "\"\r\n\r\n" + f.getValue() + "\r\n").getBytes(StandardCharsets.UTF_8));
        }
        out.writeBytes(("--" + b + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"clip.mp4\"\r\nContent-Type: video/mp4\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.writeBytes(mp4);
        out.writeBytes(("\r\n--" + b + "--\r\n").getBytes(StandardCharsets.UTF_8));
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/v1/files"))
                .timeout(Duration.ofMinutes(3))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "multipart/form-data; boundary=" + b)
                .POST(HttpRequest.BodyPublishers.ofByteArray(out.toByteArray()))
                .build();
        try {
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            if (res.statusCode() / 100 != 2) {
                log.warn("SAM upload {}: {}", res.statusCode(), clip(res.body()));
                throw new SamUpstreamException("upload " + res.statusCode());
            }
            String id = json.readTree(res.body()).path("id").asString("");
            if (!id.matches("file[-_][A-Za-z0-9_-]{1,100}")) throw new SamUpstreamException("bad file id");
            return id;
        } catch (IOException e) {
            throw new SamUpstreamException("upload unreachable");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new SamCancelledException();
        }
    }

    @Override
    public long track(String fileId, String prompt, Consumer<String> onDelta, BooleanSupplier cancelled) throws InterruptedException {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("stream", true);
        body.put("metadata", Map.of("mask_encoding", "one_bit"));
        body.put("input", List.of(Map.of("type", "message", "role", "user", "content", List.of(
                Map.of("type", "input_text", "text", prompt), Map.of("type", "input_video", "file_id", fileId)))));
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/v1/responses"))
                .timeout(IDLE)
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .header("Accept", "text/event-stream")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)))
                .build();
        HttpResponse<InputStream> res;
        try {
            res = http.send(req, HttpResponse.BodyHandlers.ofInputStream());
        } catch (IOException e) {
            throw new SamUpstreamException("SAM unreachable");
        }
        InputStream in = res.body();
        if (res.statusCode() / 100 != 2) {
            try (in) {
                log.warn("SAM upstream {}: {}", res.statusCode(), clip(new String(in.readNBytes(600), StandardCharsets.UTF_8)));
            } catch (IOException ignored) {
                // 錯誤內容讀不到就算了
            }
            throw new SamUpstreamException("SAM " + res.statusCode());
        }
        // 取消或閒置太久就關掉串流，讓卡在 readLine 的讀取返回
        long[] last = {System.nanoTime()};
        ScheduledFuture<?> watch = watchdog.scheduleWithFixedDelay(() -> {
            if (cancelled.getAsBoolean() || System.nanoTime() - last[0] > IDLE.toNanos()) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // 已經關了
                }
            }
        }, WATCH_MS, WATCH_MS, TimeUnit.MILLISECONDS);
        try (var reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
            return SamSse.read(new BufferedReader(reader) {
                @Override
                public String readLine() throws IOException {
                    String line = super.readLine();
                    last[0] = System.nanoTime();
                    return line;
                }
            }, json, onDelta, cancelled);
        } catch (IOException e) {
            if (cancelled.getAsBoolean()) throw new SamCancelledException();
            throw new SamUpstreamException("SAM stream broken or idle");
        } finally {
            watch.cancel(false);
        }
    }

    @Override
    public void delete(String fileId) {
        HttpRequest req = HttpRequest.newBuilder(URI.create(baseUrl + "/v1/files/" + fileId))
                .timeout(Duration.ofSeconds(30))
                .header("Authorization", "Bearer " + apiKey)
                .DELETE()
                .build();
        try {
            int status = http.send(req, HttpResponse.BodyHandlers.discarding()).statusCode();
            if (status / 100 != 2 && status != 404) log.warn("SAM delete {} -> {}", fileId, status);
        } catch (IOException e) {
            log.warn("SAM delete {} failed: {}", fileId, e.getMessage());
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** log 只記前 300 字 */
    private static String clip(String s) {
        return s.length() > 300 ? s.substring(0, 300) : s;
    }
}
