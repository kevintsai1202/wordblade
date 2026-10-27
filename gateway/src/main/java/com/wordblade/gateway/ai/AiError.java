package com.wordblade.gateway.ai;

/**
 * 一則要回饋給模型的錯誤（原專案 anim_ai 的錯誤格式）。
 *
 * @param stage     階段：json、schema、compile、smoke、variants、path、blank（桌面沙盒 vet 的階段）
 * @param component 哪一個新插件（components 的索引；不是插件的錯誤為 null）
 * @param message   錯誤訊息（來自我們的驗證器，不是模型的文字）
 * @param line      行（編譯、執行錯誤才有）
 * @param column    欄
 */
public record AiError(String stage, Integer component, String message, Integer line, Integer column) {}
