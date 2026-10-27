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
 * POST {base}/v1/asr/transcribe，multipart：request（JSON：model、audioEncoding=WAV、mode=DIARIZATION、keywords）＋ audio（WAV）。
 * 原專案實測（2026-09-16）：PUSH_TO_TALK 不回時間、CONVERSATION 回 400，只有 DIARIZATION 有 turn 級 startMs／endMs。
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
        if (!keywords.isEmpty()) request.put("keywords", keywords);
        // multipart 自己組：Spring 的 FormHttpMessageConverter 會在每個 part 加 Content-Length 標頭，
        // Meta 對這種寫法回 400「Malformed multipart body」（2026-10-27 實測；拿掉就 200）
        String boundary = "wordblade-" + UUID.randomUUID();
        byte[] payload = multipart(boundary, json.writeValueAsString(request), wav);
        String body;
        try {
            body = rest.post().uri("/v1/asr/transcribe")
                    .contentType(MediaType.parseMediaType("multipart/form-data; boundary=" + boundary))
                    .accept(MediaType.APPLICATION_JSON)
                    .body(payload)
                    .retrieve().body(String.class);
        } catch (RestClientResponseException e) {
            // 上游的錯誤訊息只記 log（前 300 字），不回給桌面
            String detail = e.getResponseBodyAsString();
            log.warn("ASR upstream {}: {}", e.getStatusCode().value(), detail.length() > 300 ? detail.substring(0, 300) : detail);
            throw new AsrUpstreamException(e.getStatusCode().value(), "ASR upstream error " + e.getStatusCode().value());
        } catch (RestClientException e) {
            log.warn("ASR upstream unreachable: {}", e.getMessage());
            throw new AsrUpstreamException(0, "ASR upstream unreachable");
        }
        return parse(body);
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

    /** 只取需要的欄位；格式不對算上游錯誤 */
    private AsrResult parse(String body) {
        try {
            JsonNode root = json.readTree(body);
            List<AsrResult.Turn> turns = new ArrayList<>();
            for (JsonNode t : root.path("turns")) {
                JsonNode speaker = t.get("speaker");
                turns.add(new AsrResult.Turn(t.path("transcript").asString(""), t.path("startMs").asLong(0), t.path("endMs").asLong(0),
                        speaker == null || speaker.isNull() ? null : speaker.asString()));
            }
            return new AsrResult(root.path("transcript").asString(""), turns, root.path("audioDurationMs").asLong(0));
        } catch (RuntimeException e) {
            throw new AsrUpstreamException(0, "ASR upstream returned an unreadable response");
        }
    }
}
