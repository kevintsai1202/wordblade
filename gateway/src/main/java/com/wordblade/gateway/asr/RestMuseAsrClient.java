package com.wordblade.gateway.asr;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientException;
import org.springframework.web.client.RestClientResponseException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Muse Voice Transcribe 的轉送（spec §6 轉送路由，Spring AI 沒有對應的模型介面）：
 * POST {base}/v1/asr/transcribe，multipart：request（JSON：model、audioEncoding=WAV、mode=DIARIZATION、partialMode=DELTA、keywords）
 * ＋ audio（WAV），Accept: text/event-stream。串流讀完後整理成一個 JSON 回給桌面（turns＋deltas）。
 * 原專案實測（2026-09-16）：PUSH_TO_TALK 不回時間、CONVERSATION 回 400，只有 DIARIZATION 有 turn 級時間；
 * 2026-10-27 實測：DELTA 的文字事件約每 0.32 秒一個、每個約 1.2 字，事件時間比字的開口晚 0.4～1.1 秒——當詞級時間的錨點。
 */
public class RestMuseAsrClient implements MuseAsrClient {

    private static final Logger log = LoggerFactory.getLogger(RestMuseAsrClient.class);

    private final RestClient rest;
    private final String model;
    private final JsonMapper json;

    /** rest 要已設好 baseUrl 與 Authorization 標頭 */
    public RestMuseAsrClient(RestClient rest, String model, JsonMapper json) {
        this.rest = rest;
        this.model = model;
        this.json = json;
    }

    @Override
    public AsrResult transcribe(byte[] wav, List<String> keywords) {
        Map<String, Object> request = new LinkedHashMap<>();
        request.put("model", model);
        request.put("audioEncoding", "WAV");
        request.put("mode", "DIARIZATION");
        request.put("partialMode", "DELTA");
        if (!keywords.isEmpty()) request.put("keywords", keywords);
        // multipart 自己組：Spring 的 FormHttpMessageConverter 會在每個 part 加 Content-Length 標頭，
        // Meta 對這種寫法回 400「Malformed multipart body」（2026-10-27 實測；拿掉就 200）
        String boundary = "wordblade-" + UUID.randomUUID();
        byte[] payload = multipart(boundary, json.writeValueAsString(request), wav);
        byte[] body;
        try {
            body = rest.post().uri("/v1/asr/transcribe")
                    .contentType(MediaType.parseMediaType("multipart/form-data; boundary=" + boundary))
                    .accept(MediaType.TEXT_EVENT_STREAM)
                    .body(payload)
                    // 讀成位元組再用 UTF-8 解：Meta 的 text/event-stream 不帶 charset，body(String.class) 會當 ISO-8859-1，中文變亂碼
                    .retrieve().body(byte[].class);
        } catch (RestClientResponseException e) {
            // 上游的錯誤訊息只記 log（前 300 字），不回給桌面
            String detail = e.getResponseBodyAsString();
            log.warn("ASR upstream {}: {}", e.getStatusCode().value(), detail.length() > 300 ? detail.substring(0, 300) : detail);
            throw new AsrUpstreamException(e.getStatusCode().value(), "ASR upstream error " + e.getStatusCode().value());
        } catch (RestClientException e) {
            log.warn("ASR upstream unreachable: {}", e.getMessage());
            throw new AsrUpstreamException(0, "ASR upstream unreachable");
        }
        return parse(body == null ? "" : new String(body, StandardCharsets.UTF_8));
    }

    /** 組 multipart 本體：request（JSON）與 audio（WAV）兩個 part，part 只帶 Content-Disposition 與 Content-Type */
    static byte[] multipart(String boundary, String requestJson, byte[] wav) {
        var out = new ByteArrayOutputStream(wav.length + 512);
        out.writeBytes(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"request\"\r\nContent-Type: application/json\r\n\r\n"
                + requestJson + "\r\n--" + boundary + "\r\nContent-Disposition: form-data; name=\"audio\"; filename=\"audio.wav\"\r\n"
                + "Content-Type: audio/wav\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        out.writeBytes(wav);
        out.writeBytes(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        return out.toByteArray();
    }

    /**
     * 讀 SSE（每個事件一行 data: JSON）：transcript 事件（非 final、文字非空）→ deltas；speechStart／speechEnd／speechComplete
     * 依 turnId 組成 turns，speaker 事件的 label 給目前的 turn；error 事件算上游錯誤。其他事件（audioProgress 等）略過。
     */
    private AsrResult parse(String body) {
        List<AsrResult.Delta> deltas = new ArrayList<>();
        /** turnId → [起點, 終點, 文字, 說話者] */
        Map<Long, Object[]> turns = new LinkedHashMap<>();
        Object[] current = null;
        long lastMs = 0;
        try {
            for (String line : body.split("\r?\n")) {
                if (!line.startsWith("data:")) continue;
                JsonNode e = json.readTree(line.substring(5).strip());
                String type = e.path("type").asString("");
                long ms = e.path("audioProcessedMs").asLong(lastMs);
                lastMs = Math.max(lastMs, ms);
                switch (type) {
                    case "transcript" -> {
                        String text = e.path("transcript").asString("").strip();
                        if (!e.path("final").asBoolean(false) && !text.isEmpty()) deltas.add(new AsrResult.Delta(text, ms));
                    }
                    case "speechStart" -> {
                        current = new Object[] {ms, ms, "", null};
                        turns.put(e.path("turnId").asLong(turns.size()), current);
                    }
                    case "speaker" -> {
                        if (current != null) current[3] = e.path("label").asString(null);
                    }
                    case "speechEnd" -> turns.computeIfAbsent(e.path("turnId").asLong(-1), k -> new Object[] {ms, ms, "", null})[1] = ms;
                    case "speechComplete" -> turns.computeIfAbsent(e.path("turnId").asLong(-1), k -> new Object[] {ms, ms, "", null})[2] = e.path("transcript").asString("").strip();
                    case "error" -> {
                        log.warn("ASR upstream stream error: {}", e.path("message").asString(""));
                        throw new AsrUpstreamException(0, "ASR upstream stream error");
                    }
                    default -> { }
                }
            }
        } catch (AsrUpstreamException e) {
            throw e;
        } catch (RuntimeException e) {
            throw new AsrUpstreamException(0, "ASR upstream returned an unreadable response");
        }
        List<AsrResult.Turn> list = new ArrayList<>();
        for (Object[] t : turns.values()) list.add(new AsrResult.Turn((String) t[2], (Long) t[0], (Long) t[1], (String) t[3]));
        String transcript = String.join(" ", list.stream().map(AsrResult.Turn::transcript).filter(x -> !x.isEmpty()).toList());
        return new AsrResult(transcript, list, lastMs, deltas);
    }
}
