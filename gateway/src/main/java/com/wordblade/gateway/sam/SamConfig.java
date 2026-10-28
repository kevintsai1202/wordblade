package com.wordblade.gateway.sam;

import com.wordblade.gateway.config.GatewayProperties;
import com.wordblade.gateway.usage.UsageService;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.metadata.Usage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import tools.jackson.databind.json.JsonMapper;

/** SAM 遮罩的元件：Meta 用戶端（金鑰、模型 ID 來自設定）、工作管理（同時最多 3 個）、名詞片語翻譯（Muse Spark，推理 low）。 */
@Configuration
public class SamConfig {

    private static final Logger log = LoggerFactory.getLogger(SamConfig.class);

    /** 翻譯的系統提示詞（照原專案 face_track.TRANSLATE_SYSTEM） */
    static final String TRANSLATE_SYSTEM = "你是遮罩目標翻譯助理。使用者會給一個想在影片畫面裡遮住的東西（任何語言），把它翻成 Meta SAM 3.1 看得懂的英文名詞片語："
            + "一到四個英文單字、不加冠詞與標點，例如 license plate、name tag、credit card、sign。只回 JSON：{\"phrase\": \"…\"}；"
            + "不是畫面上看得到的東西（例如問句、指令）時回 {\"phrase\": \"\"}。不要回其他文字。";

    /** 同時最多幾個 SAM 工作 */
    static final int MAX_CONCURRENT = 3;

    @Bean
    MetaSamClient metaSamClient(@Value("${wordblade.meta.base-url}") String baseUrl,
                                @Value("${wordblade.meta.api-key}") String apiKey,
                                @Value("${wordblade.models.sam:sam-3.1}") String model) {
        return new RestMetaSamClient(baseUrl, apiKey, model, JsonMapper.builder().build());
    }

    @Bean
    SamJobs samJobs(MetaSamClient meta, UsageService usage, @Value("${wordblade.models.sam:sam-3.1}") String model) {
        ExecutorService pool = Executors.newCachedThreadPool(r -> {
            Thread t = new Thread(r, "sam-job");
            t.setDaemon(true);
            return t;
        });
        return new SamJobs(meta, pool, pool, (token, frames) -> usage.record(token, "/v1/sam", model, 0, 0, frames), MAX_CONCURRENT);
    }

    @Bean
    SamPhraseTranslator samPhraseTranslator(ChatClient.Builder chat, GatewayProperties props, UsageService usage) {
        ChatClient client = chat.build();
        JsonMapper json = JsonMapper.builder().build();
        String model = props.models().spark();
        return (tokenId, text) -> {
            try {
                ChatResponse res = client.prompt()
                        .system(TRANSLATE_SYSTEM)
                        .user(json.writeValueAsString(java.util.Map.of("target", text)))
                        .options(OpenAiChatOptions.builder().model(model).reasoningEffort("low")
                                .responseFormat(OpenAiChatModel.ResponseFormat.builder().type(OpenAiChatModel.ResponseFormat.Type.JSON_OBJECT).build()))
                        .call()
                        .chatResponse();
                Usage u = res.getMetadata().getUsage();
                usage.record(tokenId, "/v1/ai/mask-phrase", model, u.getPromptTokens(), u.getCompletionTokens(), 0);
                return json.readTree(res.getResult().getOutput().getText()).path("phrase").asString("").strip();
            } catch (RuntimeException e) {
                log.warn("mask phrase translation failed: {}", e.getMessage());
                return "";
            }
        };
    }
}
