package com.wordblade.gateway.sam;

import java.io.BufferedReader;
import java.io.IOException;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Meta /v1/responses（sam-3.1、stream）的 SSE 讀法：只取 response.output_text.delta 的文字；response.completed 記下
 * usage.video_frames_processed（計費格數）；error、response.failed、response.incomplete 算上游錯誤；讀到 data: [DONE] 結束。
 * 其他事件（created、in_progress、output_item.added…）略過。沒有 completed 就斷線也算上游錯誤。
 * 2026-10-28 實測（scripts/sam/probe.mjs）：completed 後 25 毫秒內送 [DONE] 並關連線。
 */
public final class SamSse {

    private SamSse() {}

    /** 讀完整個串流；回傳計費格數。cancelled 每行檢查一次 */
    public static long read(BufferedReader in, JsonMapper json, Consumer<String> onDelta, BooleanSupplier cancelled) throws IOException {
        Long frames = null;
        String line;
        while ((line = in.readLine()) != null) {
            if (cancelled.getAsBoolean()) throw new SamCancelledException();
            if (!line.startsWith("data:")) continue;
            String payload = line.substring(5).strip();
            if (payload.equals("[DONE]")) break;
            if (payload.isEmpty()) continue;
            JsonNode e;
            try {
                e = json.readTree(payload);
            } catch (RuntimeException ex) {
                throw new SamUpstreamException("unreadable SAM event");
            }
            switch (e.path("type").asString("")) {
                case "response.output_text.delta" -> {
                    JsonNode d = e.path("delta");
                    if (d.isString()) onDelta.accept(d.asString());
                }
                case "response.completed" -> frames = e.path("response").path("usage").path("video_frames_processed").asLong(0);
                case "error", "response.failed", "response.incomplete" -> throw new SamUpstreamException("SAM stream error: " + e.path("type").asString(""));
                default -> { }
            }
        }
        if (frames == null) throw new SamUpstreamException("SAM stream ended without completion");
        return frames;
    }
}
