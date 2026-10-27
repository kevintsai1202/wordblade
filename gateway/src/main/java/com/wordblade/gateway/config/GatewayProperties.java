package com.wordblade.gateway.config;

import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * 閘道自訂設定（前綴 wordblade）。
 *
 * @param corsAllowedOrigins CORS 放行的 Origin 清單（網頁版網域、WebView2 的 http://tauri.localhost 等）
 * @param timezone           計算「今日用量」所用的時區
 * @param models             各角色使用的模型 ID（D32，來自環境變數，不寫死在程式）
 */
@ConfigurationProperties(prefix = "wordblade")
public record GatewayProperties(List<String> corsAllowedOrigins, String timezone, Models models) {

    /** 模型 ID：spark 做苦工，wonder 統籌與 Vibe特效（D12、D31）。 */
    public record Models(String spark, String wonder) {}
}
