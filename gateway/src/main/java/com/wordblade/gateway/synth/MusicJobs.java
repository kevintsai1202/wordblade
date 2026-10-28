package com.wordblade.gateway.synth;

import com.wordblade.gateway.ai.AiModel;
import java.util.concurrent.Executor;

/** AI 音樂（WebAudio 版，spec §5.15，P1-11）的工作：一句描述＋小節數 → Muse Spark 回可循環的配樂 spec；可帶前一版 spec 修改。 */
public class MusicJobs extends SynthJobs {

    /** 一個工作的 token 上限（音符表較長，最多 2 輪） */
    static final long TOKEN_BUDGET = 50_000;

    public MusicJobs(AiModel model, SynthParser parser, Executor executor, UsageRecorder usage) {
        super(model, parser, executor, usage);
    }

    /** 開始一個配樂工作 */
    public String start(long tokenId, MusicRequest req) {
        return startJob(tokenId, userText(req), text -> parser.parseMusic(text, req.bars()), TOKEN_BUDGET);
    }

    /** 使用者訊息：小節數＋描述（或前一版 spec＋修改指示） */
    static String userText(MusicRequest r) {
        return describe(new StringBuilder("配樂 ").append(r.bars()).append(" 小節（bars 用這個值）。\n"), r.description(), r.previous());
    }
}
