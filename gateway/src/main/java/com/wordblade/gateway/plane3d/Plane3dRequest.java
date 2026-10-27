package com.wordblade.gateway.plane3d;

import tools.jackson.databind.JsonNode;

/**
 * 「用說的」的請求（spec §5.8）。
 *
 * @param description 使用者的一句描述（不可信資料，≤ 300 字）
 * @param screenshot  選填：播放頭這一格的畫面（data URL，JPEG／PNG，≤ 2 MB）
 * @param length      3D 區段長度（秒）
 * @param width       畫面寬（像素）
 * @param height      畫面高
 * @param current     目前的板子設定（keys、float、edges、background、color、shadow）
 */
public record Plane3dRequest(String description, String screenshot, double length, int width, int height, JsonNode current) {}
