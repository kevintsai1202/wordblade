package com.wordblade.gateway.publish;

import com.wordblade.gateway.ai.AiModel;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;
import org.springframework.util.LinkedMultiValueMap;
import org.springframework.util.MultiValueMap;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** 發佈包用到的兩個 Meta API 呼叫（RestClient 直打）。 */
final class RestPublishModels {

    private RestPublishModels() {}

    /**
     * Muse Spark 寫發佈包：/v1/chat/completions，system＝資源檔 publish/prompt.txt（換掉 {{LANGUAGE}}、{{DURATION}}），
     * user＝帶時間標記的逐字稿；response_format json_schema strict（publish/schema.json），reasoning_effort low。
     * 字數上限寫在提示詞裡（strict schema 不保證支援 maxLength），閘道收到後再截一次。
     */
    record SparkText(RestClient rest, String model, String prompt, JsonNode schema, JsonMapper json) implements PublishJobs.TextModel {
        @Override
        public AiModel.Reply write(String language, double duration, String transcript) {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("model", model);
            body.put("reasoning_effort", "low");
            body.put("response_format", Map.of("type", "json_schema", "json_schema", Map.of("name", "publish_kit", "strict", true, "schema", schema)));
            body.put("messages", List.of(
                    Map.of("role", "system", "content", prompt.replace("{{LANGUAGE}}", language).replace("{{DURATION}}", String.valueOf(Math.round(duration)))),
                    Map.of("role", "user", "content", transcript)));
            JsonNode res = json.readTree(rest.post().uri("/v1/chat/completions").contentType(MediaType.APPLICATION_JSON)
                    .body(json.writeValueAsString(body)).retrieve().body(String.class));
            JsonNode usage = res.path("usage");
            return new AiModel.Reply(res.path("choices").path(0).path("message").path("content").asString(""),
                    usage.path("prompt_tokens").asLong(0), usage.path("completion_tokens").asLong(0), model);
        }
    }

    /**
     * Muse Image 改圖：/v1/images/edits（multipart：model、prompt、size、image）。
     * 2026-10-29 實測（scripts/publish/probe-image.mjs）：size 要 WxH，1792x1024 實際給 2016×1152；回 data[0].b64_json，output_format webp；約 32 秒。
     */
    record MuseImage(RestClient rest, String model, JsonMapper json) implements PublishJobs.ImageModel {
        @Override
        public PublishJobs.ImageReply edit(String prompt, byte[] image, String mime) {
            MultiValueMap<String, Object> form = new LinkedMultiValueMap<>();
            form.add("model", model);
            form.add("prompt", prompt);
            form.add("size", "1792x1024");
            HttpHeaders partHeaders = new HttpHeaders();
            partHeaders.setContentType(MediaType.parseMediaType(mime));
            String filename = "image/png".equals(mime) ? "frame.png" : "frame.jpg";
            form.add("image", new HttpEntity<>(new ByteArrayResource(image) {
                @Override
                public String getFilename() {
                    return filename;
                }
            }, partHeaders));
            JsonNode res = json.readTree(rest.post().uri("/v1/images/edits").contentType(MediaType.MULTIPART_FORM_DATA)
                    .body(form).retrieve().body(String.class));
            return reply(res);
        }

        /** 產生新圖：/v1/images/generations（JSON：model、prompt、size）；回應格式和 edits 一樣 */
        @Override
        public PublishJobs.ImageReply generate(String prompt, String size) {
            var body = json.createObjectNode().put("model", model).put("prompt", prompt).put("size", size);
            JsonNode res = json.readTree(rest.post().uri("/v1/images/generations").contentType(MediaType.APPLICATION_JSON)
                    .body(json.writeValueAsString(body)).retrieve().body(String.class));
            return reply(res);
        }

        /** 回應 → 圖片位元組、格式、用量 */
        private PublishJobs.ImageReply reply(JsonNode res) {
            String b64 = res.path("data").path(0).path("b64_json").asString("");
            String format = res.path("output_format").asString("png");
            JsonNode usage = res.path("usage");
            return new PublishJobs.ImageReply(b64.isEmpty() ? new byte[0] : Base64.getDecoder().decode(b64), "image/" + format,
                    usage.path("input_tokens").asLong(0), usage.path("output_tokens").asLong(0), model);
        }
    }
}
