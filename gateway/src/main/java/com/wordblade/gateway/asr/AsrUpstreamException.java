package com.wordblade.gateway.asr;

/** Meta 的 ASR 回錯誤（HTTP 狀態碼；0 表示連不上或回應看不懂） */
public class AsrUpstreamException extends RuntimeException {

    private final int status;

    public AsrUpstreamException(int status, String message) {
        super(message);
        this.status = status;
    }

    /** 上游的 HTTP 狀態碼 */
    public int status() {
        return status;
    }
}
