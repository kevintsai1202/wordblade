package com.wordblade.gateway.locate;

import com.wordblade.gateway.ai.AiModel;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * Muse Spark 看幾張畫面找文字的框：/v1/chat/completions，content 放說明＋多張 image_url（JPEG data URL），
 * response_format json_schema strict（資源檔 locate/schema.json），reasoning_effort low。
 * 2026-10-28 實測（scripts/sam/probe-locate.mjs）：3 張 1280 寬，3.7k prompt tokens、8.5 秒，demo 金鑰 IoU 0.82。
 */
public class RestSparkImageClient implements LocateJobs.ImageModel {

    private final RestClient rest;
    private final String model;
    private final String prompt;
    private final JsonNode schema;
    private final JsonMapper json;

    /** prompt 裡的 {{TARGET}}、{{COUNT}} 會換成目標與張數 */
    public RestSparkImageClient(RestClient rest, String model, String prompt, JsonNode schema, JsonMapper json) {
        this.rest = rest;
        this.model = model;
        this.prompt = prompt;
        this.schema = schema;
        this.json = json;
    }

    @Override
    public AiModel.Reply analyze(String target, List<byte[]> jpegs) {
        List<Object> content = new ArrayList<>();
        content.add(Map.of("type", "text", "text", prompt.replace("{{TARGET}}", target).replace("{{COUNT}}", String.valueOf(jpegs.size()))));
        for (byte[] jpeg : jpegs) content.add(Map.of("type", "image_url", "image_url", Map.of("url", "data:image/jpeg;base64," + Base64.getEncoder().encodeToString(jpeg))));
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("model", model);
        body.put("reasoning_effort", "low");
        body.put("response_format", Map.of("type", "json_schema", "json_schema", Map.of("name", "locate", "strict", true, "schema", schema)));
        body.put("messages", List.of(Map.of("role", "user", "content", content)));
        JsonNode res = json.readTree(rest.post().uri("/v1/chat/completions").contentType(MediaType.APPLICATION_JSON)
                .body(json.writeValueAsString(body)).retrieve().body(String.class));
        JsonNode usage = res.path("usage");
        return new AiModel.Reply(res.path("choices").path(0).path("message").path("content").asString(""),
                usage.path("prompt_tokens").asLong(0), usage.path("completion_tokens").asLong(0), model);
    }
}
