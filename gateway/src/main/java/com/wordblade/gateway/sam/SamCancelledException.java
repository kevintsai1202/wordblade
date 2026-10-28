package com.wordblade.gateway.sam;

/** 桌面取消了這個 SAM 工作 */
public class SamCancelledException extends RuntimeException {
    public SamCancelledException() {
        super("cancelled");
    }
}
