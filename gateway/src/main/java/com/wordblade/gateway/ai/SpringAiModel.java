package com.wordblade.gateway.ai;

import java.util.ArrayList;
import java.util.List;
import org.springframework.ai.chat.client.ChatClient;
import org.springframework.ai.chat.memory.ChatMemory;
import org.springframework.ai.chat.messages.AssistantMessage;
import org.springframework.ai.chat.messages.Message;
import org.springframework.ai.chat.messages.UserMessage;
import org.springframework.ai.chat.metadata.Usage;
import org.springframework.ai.chat.model.ChatResponse;
import org.springframework.ai.content.Media;
import org.springframework.ai.openai.OpenAiChatModel;
import org.springframework.ai.openai.OpenAiChatOptions;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.util.MimeType;

/**
 * 用 Spring AI 呼叫 Muse Wonder（D31，推理深度 medium）：ChatClient 送系統提示＋這段對話的歷史＋新的使用者訊息，
 * 回應用 JSON 模式（response_format json_object；回應裡的 params 是開放物件，嚴格 json_schema 表達不了）。
 * 對話歷史存在 ChatMemory（以工作 id 為對話 id）。截圖只在第一輪送：存進記憶的是不含圖的文字版，續跑不重送截圖（原專案做法）。
 */
public class SpringAiModel implements AiModel {

    private final ChatClient chat;
    private final ChatMemory memory;
    private final String systemPrompt;
    private final String model;
    private final String reasoning;
    /** 取樣溫度與種子（null＝用模型預設）；AI 導演用 0 與固定種子讓同一支片的結果穩定 */
    private final Double temperature;
    private final Integer seed;

    /**
     * @param chat         ChatClient（底層是 OpenAI 相容的 Muse API）
     * @param memory       每個工作的對話歷史
     * @param systemPrompt 系統提示詞（scripts/vibe/build-prompt.mjs 產生的資源檔）
     * @param model        模型 ID（WORDBLADE_MODEL_WONDER）
     * @param reasoning    推理深度
     */
    public SpringAiModel(ChatClient chat, ChatMemory memory, String systemPrompt, String model, String reasoning) {
        this(chat, memory, systemPrompt, model, reasoning, null, null);
    }

    /**
     * @param temperature 取樣溫度（null＝模型預設）
     * @param seed        亂數種子（null＝不指定）
     */
    public SpringAiModel(ChatClient chat, ChatMemory memory, String systemPrompt, String model, String reasoning, Double temperature, Integer seed) {
        this.chat = chat;
        this.memory = memory;
        this.systemPrompt = systemPrompt;
        this.model = model;
        this.reasoning = reasoning;
        this.temperature = temperature;
        this.seed = seed;
    }

    @Override
    public Reply call(String conversationId, String userText, Image image) {
        List<Message> history = new ArrayList<>(memory.get(conversationId));
        UserMessage.Builder user = UserMessage.builder().text(userText);
        if (image != null) user.media(new Media(MimeType.valueOf(image.mimeType()), new ByteArrayResource(image.bytes())));
        history.add(user.build());
        ChatResponse response = chat.prompt()
                .system(systemPrompt)
                .messages(history)
                .options(OpenAiChatOptions.builder()
                        .model(model)
                        .reasoningEffort(reasoning)
                        .temperature(temperature)
                        .seed(seed)
                        .responseFormat(OpenAiChatModel.ResponseFormat.builder().type(OpenAiChatModel.ResponseFormat.Type.JSON_OBJECT).build()))
                .call()
                .chatResponse();
        String text = response.getResult().getOutput().getText();
        memory.add(conversationId, List.of(new UserMessage(userText), new AssistantMessage(text == null ? "" : text)));
        Usage usage = response.getMetadata().getUsage();
        long in = usage.getPromptTokens() == null ? 0 : usage.getPromptTokens();
        long out = usage.getCompletionTokens() == null ? 0 : usage.getCompletionTokens();
        return new Reply(text == null ? "" : text, in, out, model);
    }

    @Override
    public void forget(String conversationId) {
        memory.clear(conversationId);
    }
}
