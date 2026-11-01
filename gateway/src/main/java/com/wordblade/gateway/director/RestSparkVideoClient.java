package com.wordblade.gateway.director;

import com.wordblade.gateway.ai.AiModel;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Muse Spark 逐段看影片（spec §5.11）：Spring AI 2.0 的 Media 送不了影片（會被當成文字），所以直接用 RestClient 組
 * /v1/chat/completions 的 JSON——content 裡放 {"type":"video_url","video_url":{"url":"data:video/mp4;base64,…"}}，
 * response_format 用 json_schema（strict，資源檔 director/segment-schema.json），reasoning_effort low。
 * 2026-10-28 實測（scripts/director/probe-segment.mjs）：108 秒 480p、每秒 2 格約 28k prompt tokens、10.5 秒。
 */
public class RestSparkVideoClient implements DirectorJobs.SegmentModel {

    private final RestClient rest;
    private final String model;
    private final String prompt;
    private final JsonNode schema;
    private final JsonMapper json;

    /**
     * @param rest   已設好 baseUrl（含 /v1 之前）與 Authorization 的 RestClient
     * @param prompt 逐段看的說明（資源檔 director/segment-prompt.txt）
     * @param schema 段落報告的 JSON Schema
     */
    public RestSparkVideoClient(RestClient rest, String model, String prompt, JsonNode schema, JsonMapper json) {
        this.rest = rest;
        this.model = model;
        this.prompt = prompt;
        this.schema = schema;
        this.json = json;
    }

    @Override
    public AiModel.Reply analyze(byte[] mp4, double length, String transcript) {
        String text = prompt.replace("{{LENGTH}}", String.format("%.1f", length)) + "\n\nTranscript (seconds into this video, word id, word):\n" + (transcript.isBlank() ? "(no speech)" : transcript);
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("reasoning_effort", "low");
        // 溫度 0＋固定種子（Spark 實測仍不完全一樣，但變化較小）
        body.put("temperature", 0);
        body.put("seed", DirectorConfig.SEED);
        body.put("response_format", Map.of("type", "json_schema", "json_schema", Map.of("name", "segment_report", "strict", true, "schema", schema)));
        body.put("messages", List.of(Map.of("role", "user", "content", List.of(
                Map.of("type", "text", "text", text),
                Map.of("type", "video_url", "video_url", Map.of("url", "data:video/mp4;base64," + Base64.getEncoder().encodeToString(mp4)))))));
        JsonNode res = json.readTree(rest.post().uri("/v1/chat/completions").contentType(MediaType.APPLICATION_JSON)
                .body(json.writeValueAsString(body)).retrieve().body(String.class));
        JsonNode usage = res.path("usage");
        return new AiModel.Reply(res.path("choices").path(0).path("message").path("content").asString(""),
                usage.path("prompt_tokens").asLong(0), usage.path("completion_tokens").asLong(0), model);
    }
}
