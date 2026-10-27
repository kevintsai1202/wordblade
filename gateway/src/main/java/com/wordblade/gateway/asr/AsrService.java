package com.wordblade.gateway.asr;

import java.util.List;

/** ASR 轉送：檢查 WAV、整理關鍵字、呼叫上游、記用量（音訊秒數，無條件進位；D29 不設上限）。 */
public class AsrService {

    /** 關鍵字最多幾個 */
    static final int MAX_KEYWORDS = 100;
    /** 每個關鍵字最多幾字 */
    static final int MAX_KEYWORD_LENGTH = 50;

    /** 記用量：權杖、模型、秒數 */
    @FunctionalInterface
    public interface UsageRecorder {
        void record(long tokenId, String model, long seconds);
    }

    private final MuseAsrClient client;
    private final UsageRecorder usage;
    private final String model;

    public AsrService(MuseAsrClient client, UsageRecorder usage, String model) {
        this.client = client;
        this.usage = usage;
        this.model = model;
    }

    /** 轉錄；WAV 不合格拋 BadWavException，上游失敗拋 AsrUpstreamException（都不記用量） */
    public AsrResult transcribe(long tokenId, byte[] wav, List<String> keywords) {
        WavInfo info = WavInfo.parse(wav);
        List<String> clean = keywords == null ? List.of() : keywords.stream()
                .map(String::strip)
                .filter(k -> !k.isEmpty())
                .map(k -> k.length() > MAX_KEYWORD_LENGTH ? k.substring(0, MAX_KEYWORD_LENGTH) : k)
                .limit(MAX_KEYWORDS)
                .toList();
        AsrResult result = client.transcribe(wav, clean);
        usage.record(tokenId, model, (long) Math.ceil(info.seconds()));
        return result;
    }
}
