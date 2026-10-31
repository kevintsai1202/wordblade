package com.wordblade.gateway.director;

import com.wordblade.gateway.ai.AiModel;
import com.wordblade.gateway.ai.SpringAiModel;
import com.wordblade.gateway.config.GatewayProperties;
import com.wordblade.gateway.usage.UsageService;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.memory.InMemoryChatMemoryRepository;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

/**
 * AI 導演的元件：Muse Spark 逐段看影片（RestClient、json_schema）、Muse Wonder 統籌（Spring AI、推理 medium、JSON 模式）、
 * 背景執行緒（同時最多 4 段——閘道在 Wonder Mesh 家用節點上，一段約 4 MB，再多記憶體與上傳都吃緊）。
 */
@Configuration
public class DirectorConfig {

    /** 同時最多幾個模型呼叫（排隊最多 20 段，再多回 429：一段可達 20 MB，不讓失控的用戶端吃光記憶體） */
    static final int THREADS = 4;
    /** 導演各模型呼叫的固定亂數種子 */
    static final int SEED = 7;
    /** Jev 每題問幾次取平均 */
    static final int JEV_TIMES = 3;

    @Bean
    DirectorJobs directorJobs(@Value("${wordblade.meta.base-url}") String baseUrl, @Value("${wordblade.meta.api-key}") String apiKey,
                              @Value("${wordblade.typesafe.base-url}") String typesafeUrl, @Value("${wordblade.typesafe.api-key:}") String typesafeKey,
                              @Value("${wordblade.typesafe.model}") String jevModel,
                              ChatClient.Builder chat, GatewayProperties props, UsageService usage) throws IOException {
        JsonMapper json = JsonMapper.builder().build();
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(10));
        factory.setReadTimeout(Duration.ofMinutes(3));
        RestClient rest = RestClient.builder().baseUrl(baseUrl).defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + apiKey).requestFactory(factory).build();
        String segmentPrompt = new ClassPathResource("director/segment-prompt.txt").getContentAsString(StandardCharsets.UTF_8);
        var schema = json.readTree(new ClassPathResource("director/segment-schema.json").getContentAsString(StandardCharsets.UTF_8));
        var spark = new RestSparkVideoClient(rest, props.models().spark(), segmentPrompt, schema, json);
        String planPrompt = new ClassPathResource("director/plan-prompt.txt").getContentAsString(StandardCharsets.UTF_8);
        var memory = MessageWindowChatMemory.builder().chatMemoryRepository(new InMemoryChatMemoryRepository()).maxMessages(10).build();
        // temperature 0＋固定種子：同一支片兩次規劃的結果穩定（2026-10-31 開發者要求；probe-sampling.mjs 實測 Wonder 兩次回應相同）
        AiModel planner = new SpringAiModel(chat.build(), memory, planPrompt, props.models().wonder(), "medium", 0.0, SEED);
        // 審查者：同一個模型、另一份系統提示詞與獨立的對話記憶（不看規劃者的對話）
        String reviewPrompt = new ClassPathResource("director/review-prompt.txt").getContentAsString(StandardCharsets.UTF_8);
        var reviewMemory = MessageWindowChatMemory.builder().chatMemoryRepository(new InMemoryChatMemoryRepository()).maxMessages(4).build();
        AiModel reviewer = new SpringAiModel(chat.build(), reviewMemory, reviewPrompt, props.models().wonder(), "medium", 0.0, SEED);
        ExecutorService pool = new ThreadPoolExecutor(THREADS, THREADS, 60, TimeUnit.SECONDS, new LinkedBlockingQueue<>(20), r -> {
            Thread t = new Thread(r, "director");
            t.setDaemon(true);
            return t;
        });
        // 重講候選交給 TypeSafe Jev 判斷（沒設金鑰就不判斷）
        // 每題問 3 次取平均（Jev 沒有溫度可調，同一請求有 ±0.03 的差異）
        DirectorJobs.RetakeJudge judge = typesafeKey.isBlank() ? null : new AveragingRetakeJudge(new RestJevRetakeJudge(
                RestClient.builder().baseUrl(typesafeUrl).defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + typesafeKey).requestFactory(factory).build(),
                jevModel, json), JEV_TIMES);
        return new DirectorJobs(spark, planner, reviewer, pool, (tokenId, m, in, out) -> usage.record(tokenId, "/v1/ai/director", m, in, out, 0), judge);
    }
}
