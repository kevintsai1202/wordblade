package com.wordblade.gateway.plane3d;

import com.wordblade.gateway.ai.AiModel;
import com.wordblade.gateway.ai.SpringAiModel;
import com.wordblade.gateway.config.GatewayProperties;
import com.wordblade.gateway.usage.UsageService;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.ExecutorService;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.memory.InMemoryChatMemoryRepository;
import org.springframework.ai.chat.memory.MessageWindowChatMemory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.core.io.ClassPathResource;
import tools.jackson.databind.json.JsonMapper;

/** 「用說的」的元件組裝：系統提示詞與範圍表（資源檔）、Muse Spark（推理 low，spec §5.8）、對話記憶、共用背景執行緒。 */
@Configuration
public class Plane3dConfig {

    /** 「用說的」的工作管理 */
    @Bean
    Plane3dJobs plane3dJobs(ChatClient.Builder chat, GatewayProperties props, UsageService usage, ExecutorService vibeExecutor) throws IOException {
        String prompt = new ClassPathResource("plane3d/system-prompt.txt").getContentAsString(StandardCharsets.UTF_8);
        var memory = MessageWindowChatMemory.builder().chatMemoryRepository(new InMemoryChatMemoryRepository()).maxMessages(10).build();
        AiModel model = new SpringAiModel(chat.build(), memory, prompt, props.models().spark(), "low");
        return new Plane3dJobs(model, Plane3dParser.fromResources(JsonMapper.builder().build()), vibeExecutor,
                (tokenId, m, in, out) -> usage.record(tokenId, "/v1/ai/plane3d", m, in, out, 0));
    }
}
