package com.wordblade.gateway.asr;

import java.util.List;

/** 呼叫 Muse Voice Transcribe（測試換成假的） */
public interface MuseAsrClient {

    /** 轉錄一段 WAV；keywords 偏向術語（可以是空的） */
    AsrResult transcribe(byte[] wav, List<String> keywords);
}
