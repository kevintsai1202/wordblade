package com.wordblade.gateway.synth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.wordblade.gateway.ai.AiJobs;
import com.wordblade.gateway.ai.AiModel;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** AI 音效與配樂的工作流程：首輪、不合格自動重問一次、兩輪都不合格就失敗、拒答、改版帶前一版 spec、用量紀錄（假模型，不連網）。 */
class SynthJobsTest {

    /** 假模型：依序回預先排好的回應，記下收到的使用者訊息 */
    static class FakeModel implements AiModel {
        final Deque<String> replies = new ArrayDeque<>();
        final List<String> userTexts = new ArrayList<>();

        @Override
        public Reply call(String conversationId, String userText, Image image) {
            userTexts.add(userText);
            return new Reply(replies.removeFirst(), 900, 300, "fake-spark");
        }

        @Override
        public void forget(String conversationId) {}
    }

    private final JsonMapper json = JsonMapper.builder().build();
    private final SynthParser parser = SynthParser.fromResources(json);
    private final FakeModel model = new FakeModel();
    private final List<String> usage = new ArrayList<>();
    /** 同步執行（測試不開執行緒） */
    private final SoundJobs sound = new SoundJobs(model, parser, Runnable::run, (tokenId, m, in, out) -> usage.add(tokenId + ":" + m + ":" + in + ":" + out));
    private final MusicJobs music = new MusicJobs(model, parser, Runnable::run, (tokenId, m, in, out) -> usage.add(tokenId + ":" + m + ":" + in + ":" + out));

    @Test
    void 音效_首輪成功_描述標成不可信資料_記用量() {
        model.replies.add(SynthParserTest.BEEP);
        String id = sound.start(7, new SoundRequest("A short beep", 0.5, null));
        AiJobs.View<SynthParser.Result> v = sound.view(7, id);
        assertThat(v.status()).isEqualTo("done");
        assertThat(v.round()).isEqualTo(1);
        assertThat(v.result().spec().get("length").asDouble()).isEqualTo(0.5);
        assertThat(model.userTexts.get(0)).contains("0.5 秒").contains("<<<A short beep>>>");
        assertThat(usage).containsExactly("7:fake-spark:900:300");
    }

    @Test
    void 不合格自動重問一次_回饋帶錯誤() {
        model.replies.add("{\"length\":0.5,\"voices\":[]}");
        model.replies.add(SynthParserTest.BEEP);
        String id = sound.start(7, new SoundRequest("beep", 0.5, null));
        AiJobs.View<SynthParser.Result> v = sound.view(7, id);
        assertThat(v.status()).isEqualTo("done");
        assertThat(v.round()).isEqualTo(2);
        assertThat(model.userTexts.get(1)).startsWith("上一個回應不合格").contains("voices 至少要 1 個");
    }

    @Test
    void 兩輪都不合格_失敗() {
        model.replies.add("not json");
        model.replies.add("{\"length\":0.5}");
        String id = sound.start(7, new SoundRequest("beep", 0.5, null));
        AiJobs.View<SynthParser.Result> v = sound.view(7, id);
        assertThat(v.status()).isEqualTo("failed");
        assertThat(v.error()).isEqualTo("invalid-response");
        assertThat(model.userTexts).hasSize(2);
    }

    @Test
    void 拒答() {
        model.replies.add("{\"refused\":\"off-topic\"}");
        String id = music.start(7, new MusicRequest("Write me a poem", 8, null));
        assertThat(music.view(7, id).result().refusal()).isEqualTo("off-topic");
    }

    @Test
    void 配樂改版_帶前一版spec與修改指示() {
        model.replies.add(SynthParserTest.PAD);
        String id = music.start(7, new MusicRequest("make it slower", 2, json.readTree(SynthParserTest.PAD)));
        assertThat(music.view(7, id).status()).isEqualTo("done");
        assertThat(model.userTexts.get(0)).contains("2 小節").contains("前一版 spec").contains("\"bpm\":120").contains("<<<make it slower>>>");
    }

    @Test
    void 別的權杖看不到這個工作() {
        model.replies.add(SynthParserTest.BEEP);
        String id = sound.start(7, new SoundRequest("beep", 0.5, null));
        assertThatThrownBy(() -> sound.view(8, id)).isInstanceOf(AiJobs.NotFoundException.class);
    }
}
