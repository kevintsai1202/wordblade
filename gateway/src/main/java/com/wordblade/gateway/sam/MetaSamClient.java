package com.wordblade.gateway.sam;

import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** 呼叫 Meta 的 SAM 3.1（Files API 上傳 → /v1/responses 串流 → 刪檔）；測試換成假的 */
public interface MetaSamClient {

    /** 上傳小檔（一小時後 Meta 自動刪）；回傳檔案 id */
    String upload(byte[] mp4);

    /** 追蹤：每段 delta 文字交給 onDelta；回傳計費格數。cancelled 為真時丟 SamCancelledException */
    long track(String fileId, String prompt, Consumer<String> onDelta, BooleanSupplier cancelled) throws InterruptedException;

    /** 刪檔（約 4～5 秒；失敗只記 log，一小時後 Meta 仍會刪） */
    void delete(String fileId);
}
