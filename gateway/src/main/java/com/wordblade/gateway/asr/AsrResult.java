package com.wordblade.gateway.asr;

import java.util.List;

/**
 * Muse ASR 的結果（只留桌面要用的欄位）：DIARIZATION 模式只有 turn 級時間，詞級時間由桌面依音量包絡重建（§5.2）。
 *
 * @param transcript      整段文字（turns 可能漏字，桌面兩者都看）
 * @param turns           各段：文字、起訖毫秒、說話者
 * @param audioDurationMs 上游算的音訊長度
 */
public record AsrResult(String transcript, List<Turn> turns, long audioDurationMs) {

    /** 一段話 */
    public record Turn(String transcript, long startMs, long endMs, String speaker) {}
}
