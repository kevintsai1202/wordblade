package com.wordblade.gateway.vibe;

import com.wordblade.gateway.ai.*;
import com.wordblade.gateway.config.GatewayProperties;
import com.wordblade.gateway.usage.UsageService;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.memory.InMemoryChatMemoryRepository;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;
import tools.jackson.databind.json.JsonMapper;

/** Vibe特效的元件組裝：系統提示詞資源檔、Muse Wonder、對話記憶、背景執行緒、用量紀錄。 */
@Configuration
public class VibeConfig {

    /** 同時最多幾個模型呼叫（其餘排隊） */
    private static final int THREADS = 4;

    /** 背景執行模型呼叫的執行緒池（有上限，排隊最多 100 個） */
    @Bean(destroyMethod = "shutdown")
    ExecutorService vibeExecutor() {
        return new ThreadPoolExecutor(THREADS, THREADS, 60, TimeUnit.SECONDS, new LinkedBlockingQueue<>(100));
    }

    /** Vibe特效的工作管理 */
    @Bean
    VibeJobs vibeJobs(ChatClient.Builder chat, GatewayProperties props, UsageService usage, ExecutorService vibeExecutor) throws IOException {
        String prompt = new ClassPathResource("vibe/system-prompt.txt").getContentAsString(StandardCharsets.UTF_8);
        // 每個工作最多 3 輪＝6 則訊息，視窗留寬一點
        var memory = MessageWindowChatMemory.builder().chatMemoryRepository(new InMemoryChatMemoryRepository()).maxMessages(20).build();
        AiModel model = new SpringAiModel(chat.build(), memory, prompt, props.models().wonder(), "medium");
        return new VibeJobs(model, new VibeParser(JsonMapper.builder().build()), vibeExecutor,
                (tokenId, m, in, out) -> usage.record(tokenId, "/v1/ai/vibe", m, in, out, 0));
    }

    /** Vibe特效 3D 的工作管理（three.js 插件；同樣用 Muse Wonder） */
    @Bean
    Vibe3dJobs vibe3dJobs(ChatClient.Builder chat, GatewayProperties props, UsageService usage, ExecutorService vibeExecutor) throws IOException {
        String prompt = new ClassPathResource("vibe/system-prompt-3d.txt").getContentAsString(StandardCharsets.UTF_8);
        var memory = MessageWindowChatMemory.builder().chatMemoryRepository(new InMemoryChatMemoryRepository()).maxMessages(20).build();
        AiModel model = new SpringAiModel(chat.build(), memory, prompt, props.models().wonder(), "medium");
        return new Vibe3dJobs(model, new Vibe3dParser(JsonMapper.builder().build()), vibeExecutor,
                (tokenId, m, in, out) -> usage.record(tokenId, "/v1/ai/vibe3d", m, in, out, 0));
    }
}
