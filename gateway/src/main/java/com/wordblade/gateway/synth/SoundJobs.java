package com.wordblade.gateway.synth;

import com.wordblade.gateway.ai.AiModel;
import java.util.concurrent.Executor;

/** AI 音效的工作（spec §5.15，P1-8）：一句描述＋長度 → Muse Spark 回音效 spec。 */
public class SoundJobs extends SynthJobs {

    /** 一個工作的 token 上限（提示詞約 1 萬 token，最多 2 輪） */
    static final long TOKEN_BUDGET = 30_000;

    public SoundJobs(AiModel model, SynthParser parser, Executor executor, UsageRecorder usage) {
        super(model, parser, executor, usage);
    }

    /** 開始一個音效工作 */
    public String start(long tokenId, SoundRequest req) {
        return startJob(tokenId, userText(req), text -> parser.parseSound(text, req.length()), TOKEN_BUDGET);
    }

    /** 使用者訊息：長度＋描述（或前一版 spec＋修改指示） */
    static String userText(SoundRequest r) {
        return describe(new StringBuilder("音效長度 ").append(SchemaLite.num(r.length())).append(" 秒（length 用這個值）。\n"), r.description(), r.previous());
    }
}
