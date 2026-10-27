package com.wordblade.gateway.asr;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;

/**
 * WAV 檔頭（spec §5.2）：Muse ASR 只收 PCM 單聲道 16-bit、16 或 24 kHz、≤ 10 分鐘（≤ 32 MB 由 multipart 上限擋）。
 * 送上游前先檢查，不合格不花錢。
 *
 * @param sampleRate 取樣率
 * @param seconds    音訊長度（data 區塊的長度換算）
 */
public record WavInfo(int sampleRate, double seconds) {

    /** 最長幾秒 */
    static final int MAX_SECONDS = 600;

    /** 檔案不是合格的 WAV；訊息直接回給桌面 */
    public static class BadWavException extends RuntimeException {
        public BadWavException(String message) {
            super(message);
        }
    }

    /** 讀檔頭並檢查格式 */
    public static WavInfo parse(byte[] bytes) {
        if (bytes.length < 44 || !tag(bytes, 0, "RIFF") || !tag(bytes, 8, "WAVE")) throw new BadWavException("not a WAV file");
        ByteBuffer b = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN);
        int channels = -1, rate = -1, bits = -1;
        long dataBytes = -1;
        // 依序走過各個區塊（fmt、LIST、data…），區塊長度是奇數時補一個位元組
        int pos = 12;
        while (pos + 8 <= bytes.length) {
            long size = Integer.toUnsignedLong(b.getInt(pos + 4));
            if (tag(bytes, pos, "fmt ") && pos + 24 <= bytes.length) {
                if (b.getShort(pos + 8) != 1) throw new BadWavException("WAV must be PCM");
                channels = b.getShort(pos + 10);
                rate = b.getInt(pos + 12);
                bits = b.getShort(pos + 22);
            } else if (tag(bytes, pos, "data")) {
                dataBytes = Math.min(size, bytes.length - pos - 8L);
                break;
            }
            pos += 8 + (int) size + (int) (size & 1);
        }
        if (channels < 0 || dataBytes < 0) throw new BadWavException("WAV is missing fmt or data chunk");
        if (channels != 1) throw new BadWavException("WAV must be mono");
        if (bits != 16) throw new BadWavException("WAV must be 16-bit");
        if (rate != 16000 && rate != 24000) throw new BadWavException("WAV sample rate must be 16000 or 24000");
        double seconds = dataBytes / 2.0 / rate;
        if (seconds > MAX_SECONDS) throw new BadWavException("WAV is longer than " + MAX_SECONDS + " seconds");
        return new WavInfo(rate, seconds);
    }

    /** 某個位置是不是這四個字元 */
    private static boolean tag(byte[] bytes, int at, String name) {
        return new String(bytes, at, 4, StandardCharsets.US_ASCII).equals(name);
    }
}
