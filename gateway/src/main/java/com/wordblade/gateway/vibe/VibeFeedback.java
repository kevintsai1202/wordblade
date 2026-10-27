package com.wordblade.gateway.vibe;

import java.util.Comparator;
import java.util.List;

/** 回饋給模型的錯誤文字（移植原專案 anim_ai.feedback_text）：依階段排序、最多 12 則、每則 ≤ 300 字，不轉述模型自己的文字。 */
public final class VibeFeedback {

    /** 階段的順序（越前面越先修） */
    private static final List<String> ORDER = List.of("json", "schema", "compile", "smoke", "variants", "path", "blank");
    /** 最多回饋幾則 */
    private static final int MAX_ERRORS = 12;
    /** 每則訊息最多幾字 */
    private static final int MAX_MESSAGE = 300;

    private VibeFeedback() {}

    /** 組回饋文字 */
    public static String text(List<VibeError> errors) {
        StringBuilder sb = new StringBuilder("上一版有以下錯誤，請修正後回傳完整的新 JSON（同樣格式，不要解釋）：");
        errors.stream()
                .sorted(Comparator.comparingInt(e -> ORDER.contains(e.stage()) ? ORDER.indexOf(e.stage()) : 99))
                .limit(MAX_ERRORS)
                .forEach(e -> {
                    String msg = e.message() == null ? "" : e.message();
                    sb.append("\n- [").append(e.stage() == null ? "?" : e.stage()).append("] ");
                    if (e.component() != null) sb.append("components[").append(e.component()).append("] ");
                    sb.append(msg.length() > MAX_MESSAGE ? msg.substring(0, MAX_MESSAGE) : msg);
                    if (e.line() != null) sb.append("（第 ").append(e.line()).append(" 行第 ").append(e.column() == null ? 0 : e.column()).append(" 欄）");
                });
        return sb.toString();
    }
}
