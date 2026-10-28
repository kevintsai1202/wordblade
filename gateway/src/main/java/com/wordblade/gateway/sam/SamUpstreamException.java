package com.wordblade.gateway.sam;

/** Meta 的 SAM 或 Files API 失敗（上游的錯誤內容只記 log，不回給桌面） */
public class SamUpstreamException extends RuntimeException {
    public SamUpstreamException(String message) {
        super(message);
    }
}
