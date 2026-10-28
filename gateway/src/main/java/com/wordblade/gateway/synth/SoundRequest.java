package com.wordblade.gateway.synth;

import tools.jackson.databind.JsonNode;

/**
 * AI 音效的請求（spec §5.15）。
 *
 * @param description 使用者的一句描述，改版時是修改指示（不可信資料，≤ 300 字）
 * @param length      音效長度（秒，0.05～10）
 * @param previous    選填：前一版 spec（改版時帶著，請模型照指示修改）
 */
public record SoundRequest(String description, double length, JsonNode previous) {}
