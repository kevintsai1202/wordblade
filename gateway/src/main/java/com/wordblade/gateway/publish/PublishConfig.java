package com.wordblade.gateway.publish;

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

/** 發佈包的元件：Muse Spark（json_schema）、Muse Image（edits）、背景執行緒（同時 3 個、排隊 20 個，再多回 429）。 */
@Configuration
public class PublishConfig {

    @Bean
    PublishJobs publishJobs(@Value("${wordblade.meta.base-url}") String baseUrl, @Value("${wordblade.meta.api-key}") String apiKey,
                            @Value("${wordblade.models.image}") String imageModel, GatewayProperties props, UsageService usage) throws IOException {
        JsonMapper json = JsonMapper.builder().build();
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(10));
        factory.setReadTimeout(Duration.ofMinutes(3));
        RestClient rest = RestClient.builder().baseUrl(baseUrl).defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + apiKey).requestFactory(factory).build();
        String prompt = new ClassPathResource("publish/prompt.txt").getContentAsString(StandardCharsets.UTF_8);
        var schema = json.readTree(new ClassPathResource("publish/schema.json").getContentAsString(StandardCharsets.UTF_8));
        var spark = new RestPublishModels.SparkText(rest, props.models().spark(), prompt, schema, json);
        var image = new RestPublishModels.MuseImage(rest, imageModel, json);
        var pool = new ThreadPoolExecutor(3, 3, 60, TimeUnit.SECONDS, new LinkedBlockingQueue<>(20), r -> {
            Thread t = new Thread(r, "publish");
            t.setDaemon(true);
            return t;
        });
        return new PublishJobs(spark, image, pool, usage::record);
    }
}
