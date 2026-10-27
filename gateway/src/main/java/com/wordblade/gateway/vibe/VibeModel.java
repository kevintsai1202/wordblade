package com.wordblade.gateway.vibe;

/** 呼叫模型的一輪對話（實作用 Spring AI ChatClient＋ChatMemory；測試用假模型）。 */
public interface VibeModel {

    /** 截圖 */
    record Image(String mimeType, byte[] bytes) {}

    /** 模型的回應與用量 */
    record Reply(String text, long inputTokens, long outputTokens, String model) {}

    /**
     * 送出這段對話的下一則使用者訊息（第一輪可附截圖），回傳模型回應；之前的對話由實作依 conversationId 記住。
     */
    Reply call(String conversationId, String userText, Image image);

    /** 工作結束：丟掉這段對話 */
    void forget(String conversationId);
}
