package com.wordblade.gateway.tts;

import com.wordblade.gateway.usage.UsageService;
import java.time.Duration;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;

/**
 * AI 重生語音的元件（spec §5.6）：Fish Audio 的 /v1/tts（即時克隆）、背景執行緒（同時 2 個、排隊 10 個，再多回 429）。
 * 金鑰 FISH_API_KEY（scripts/gateway-zeabur.ps1 同步到 Zeabur）；沒設金鑰時呼叫會失敗、工作標 failed。
 */
@Configuration
public class TtsConfig {

    @Bean
    TtsJobs ttsJobs(@Value("${wordblade.fish.base-url}") String baseUrl, @Value("${wordblade.fish.api-key:}") String apiKey,
                    @Value("${wordblade.fish.model}") String model, UsageService usage) {
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(10));
        // 免費模型不保證延遲（D32）
        factory.setReadTimeout(Duration.ofMinutes(3));
        RestClient rest = RestClient.builder().baseUrl(baseUrl).defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + apiKey).requestFactory(factory).build();
        TtsJobs.Speech fish = (body) -> rest.post().uri("/v1/tts").header("model", model)
                .header(HttpHeaders.CONTENT_TYPE, "application/msgpack").body(MsgPack.pack(body)).retrieve().body(byte[].class);
        var pool = new ThreadPoolExecutor(2, 2, 60, TimeUnit.SECONDS, new LinkedBlockingQueue<>(10), r -> {
            Thread t = new Thread(r, "tts");
            t.setDaemon(true);
            return t;
        });
        return new TtsJobs(fish, pool, usage::record, model);
    }
}
