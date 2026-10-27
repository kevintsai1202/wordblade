package com.wordblade.gateway.asr;

import com.wordblade.gateway.usage.UsageService;
import java.time.Duration;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

/** ASR 轉送的元件：上游網址與金鑰、模型 ID 都來自設定（D32：模型 ID 不寫死）。 */
@Configuration
public class AsrConfig {

    /** 呼叫 Meta 的 RestClient：讀取逾時 5 分鐘（554 秒的音訊實測約 89 秒） */
    @Bean
    MuseAsrClient museAsrClient(@Value("${wordblade.meta.base-url}") String baseUrl,
                                @Value("${wordblade.meta.api-key}") String apiKey,
                                @Value("${wordblade.models.asr}") String model,
                                JsonMapper json) {
        var factory = new SimpleClientHttpRequestFactory();
        factory.setConnectTimeout(Duration.ofSeconds(10));
        factory.setReadTimeout(Duration.ofMinutes(5));
        RestClient rest = RestClient.builder()
                .baseUrl(baseUrl)
                .defaultHeader(HttpHeaders.AUTHORIZATION, "Bearer " + apiKey)
                .requestFactory(factory)
                .build();
        return new RestMuseAsrClient(rest, model, json);
    }

    @Bean
    AsrService asrService(MuseAsrClient client, UsageService usage, @Value("${wordblade.models.asr}") String model) {
        return new AsrService(client, (token, m, seconds) -> usage.record(token, "asr", m, 0, 0, seconds), model);
    }
}
