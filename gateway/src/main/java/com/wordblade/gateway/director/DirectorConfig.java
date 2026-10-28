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

    /** 同時最多幾個模型呼叫 */
    static final int THREADS = 4;

    @Bean
    DirectorJobs directorJobs(@Value("${wordblade.meta.base-url}") String baseUrl, @Value("${wordblade.meta.api-key}") String apiKey,
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
        AiModel wonder = new SpringAiModel(chat.build(), memory, planPrompt, props.models().wonder(), "medium");
        ExecutorService pool = new ThreadPoolExecutor(THREADS, THREADS, 60, TimeUnit.SECONDS, new LinkedBlockingQueue<>(500), r -> {
            Thread t = new Thread(r, "director");
            t.setDaemon(true);
            return t;
        });
        return new DirectorJobs(spark, wonder, pool, (tokenId, m, in, out) -> usage.record(tokenId, "/v1/ai/director", m, in, out, 0));
    }
}
