package com.wordblade.gateway.locate;

import com.wordblade.gateway.config.GatewayProperties;
import com.wordblade.gateway.usage.UsageService;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

/** 螢幕文字定位的元件：Muse Spark（RestClient、image_url、json_schema）、背景執行緒（同時 3 個、排隊 20 個，再多回 429）。 */
@Configuration
public class LocateConfig {

    @Bean
    LocateJobs locateJobs(@Value("${wordblade.meta.base-url}") String baseUrl, @Value("${wordblade.meta.api-key}") String apiKey,
                          GatewayProperties props, UsageService usage) throws IOException {
        JsonMapper json = JsonMapper.builder().build();
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(10));
        factory.setReadTimeout(Duration.ofMinutes(2));
        RestClient rest = RestClient.builder().baseUrl(baseUrl).defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + apiKey).requestFactory(factory).build();
        String prompt = new ClassPathResource("locate/prompt.txt").getContentAsString(StandardCharsets.UTF_8);
        var schema = json.readTree(new ClassPathResource("locate/schema.json").getContentAsString(StandardCharsets.UTF_8));
        var spark = new RestSparkImageClient(rest, props.models().spark(), prompt, schema, json);
        var pool = new ThreadPoolExecutor(3, 3, 60, TimeUnit.SECONDS, new LinkedBlockingQueue<>(20), r -> {
            Thread t = new Thread(r, "locate");
            t.setDaemon(true);
            return t;
        });
        return new LocateJobs(spark, pool, (tokenId, m, in, out) -> usage.record(tokenId, "/v1/ai/locate", m, in, out, 0));
    }
}
