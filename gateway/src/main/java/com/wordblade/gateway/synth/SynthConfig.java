package com.wordblade.gateway.synth;

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

/**
 * AI 音效與音樂的元件組裝（spec §5.15）：系統提示詞與 schema（資源檔，scripts/synth/build-prompt.mjs 產生）、
 * Muse Spark（模型 ID 來自設定 wordblade.models.spark，推理 low）、對話記憶、和 Vibe特效共用的背景執行緒。
 */
@Configuration
public class SynthConfig {

    /** 共用的解析器（schema 只讀一次） */
    @Bean
    SynthParser synthParser() {
        return SynthParser.fromResources(JsonMapper.builder().build());
    }

    /** AI 音效的工作管理 */
    @Bean
    SoundJobs soundJobs(ChatClient.Builder chat, GatewayProperties props, UsageService usage, ExecutorService vibeExecutor, SynthParser synthParser) throws IOException {
        AiModel model = model(chat, props, "synth/system-prompt-sound.txt");
        return new SoundJobs(model, synthParser, vibeExecutor, (tokenId, m, in, out) -> usage.record(tokenId, "/v1/ai/sound", m, in, out, 0));
    }

    /** AI 音樂的工作管理 */
    @Bean
    MusicJobs musicJobs(ChatClient.Builder chat, GatewayProperties props, UsageService usage, ExecutorService vibeExecutor, SynthParser synthParser) throws IOException {
        AiModel model = model(chat, props, "synth/system-prompt-music.txt");
        return new MusicJobs(model, synthParser, vibeExecutor, (tokenId, m, in, out) -> usage.record(tokenId, "/v1/ai/music", m, in, out, 0));
    }

    /** 一種工作的模型：自己的系統提示詞與對話記憶（最多 2 輪＝4 則訊息） */
    private static AiModel model(ChatClient.Builder chat, GatewayProperties props, String promptPath) throws IOException {
        String prompt = new ClassPathResource(promptPath).getContentAsString(StandardCharsets.UTF_8);
        var memory = MessageWindowChatMemory.builder().chatMemoryRepository(new InMemoryChatMemoryRepository()).maxMessages(10).build();
        return new SpringAiModel(chat.build(), memory, prompt, props.models().spark(), "low");
    }
}
