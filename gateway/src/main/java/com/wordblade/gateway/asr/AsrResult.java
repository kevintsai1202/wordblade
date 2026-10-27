package com.wordblade.gateway.asr;

import java.util.List;

/**
 * Muse ASR 的結果（只留桌面要用的欄位）。Muse 沒有詞級時間；閘道用 DELTA 串流，把每個文字事件與當時的
 * audioProcessedMs 一起回傳，桌面拿它當每個字的時間錨點，再依音量包絡細調（§5.2）。
 *
 * @param transcript      整段文字（各 turn 的 speechComplete 接起來）
 * @param turns           各段：文字、起訖毫秒（speechStart／speechEnd 事件的 audioProcessedMs，比實際晚）、說話者
 * @param audioDurationMs 音訊長度（最後一個事件的 audioProcessedMs）
 * @param deltas          DELTA 文字事件：一兩個字＋事件當時處理到的毫秒數（比字的結尾晚一點）
 */
public record AsrResult(String transcript, List<Turn> turns, long audioDurationMs, List<Delta> deltas) {

    /** 一段話 */
    public record Turn(String transcript, long startMs, long endMs, String speaker) {}

    /** 一個 DELTA 文字事件 */
    public record Delta(String text, long ms) {}
}
