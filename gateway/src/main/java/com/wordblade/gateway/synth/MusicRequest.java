package com.wordblade.gateway.synth;

import tools.jackson.databind.JsonNode;

/**
 * AI 音樂（WebAudio 版）的請求（spec §5.15）。
 *
 * @param description 使用者的一句描述（風格、速度、情緒），改版時是修改指示（不可信資料，≤ 300 字）
 * @param bars        小節數（1～32）；長度＝bars × 每小節拍數 × 60 ÷ bpm，由模型選的 bpm 決定
 * @param previous    選填：前一版 spec（「改一下」時帶著）
 */
public record MusicRequest(String description, int bars, JsonNode previous) {}
