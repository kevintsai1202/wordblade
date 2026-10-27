package com.wordblade.gateway.vibe;

import tools.jackson.databind.JsonNode;

/**
 * Vibe特效的請求（桌面或網頁版送來）。
 *
 * @param description 使用者的一句描述（不可信資料，≤ 500 字）
 * @param screenshot  選填：目前這一格的截圖（data URL，JPEG／PNG，≤ 2 MB）
 * @param duration    特效長度（秒）
 * @param fps         格率
 * @param width       1080p 虛擬畫布的寬（依片子比例）
 * @param box         目標框（虛擬像素）
 * @param base        選填：要修改的底稿插件（完整元件 JSON，不可信資料）
 */
public record VibeRequest(String description, String screenshot, double duration, int fps, int width, Box box, JsonNode base) {

    /** 目標框（虛擬像素） */
    public record Box(double x, double y, double w, double h) {}
}
