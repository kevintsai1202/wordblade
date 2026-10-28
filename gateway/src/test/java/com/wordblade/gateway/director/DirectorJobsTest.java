package com.wordblade.gateway.director;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.wordblade.gateway.ai.AiModel;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Deque;
import java.util.List;
import org.junit.jupiter.api.Test;

/** AI 導演工作：逐段交給 Spark（時間換成素材時間）→ 全部回來交給 Wonder → 檢查不合格就回饋一次 → 建議；段落失敗、取消、權杖隔離。 */
class DirectorJobsTest {

    /** 假 Spark：依段落回固定報告（段內秒數），記下收到的逐字稿 */
    static class FakeSpark implements DirectorJobs.SegmentModel {
        final List<String> transcripts = Collections.synchronizedList(new ArrayList<>());
        boolean failSecond;

        @Override
        public AiModel.Reply analyze(byte[] mp4, double length, String transcript) {
            transcripts.add(transcript);
            if (failSecond && transcript.contains("w9")) throw new RuntimeException("boom");
            return new AiModel.Reply("""
                    {"summary":"s","retakes":[{"start":2,"end":4,"reason":"stumble"}],"privacy":[{"start":5,"end":8,"target":"API key","x":0.1,"y":0.1,"w":0.3,"h":0.05}],
                     "highlights":[],"misheard":[]}""", 1000, 100, "fake-spark");
        }
    }

    /** 假 Wonder：依序回排好的回應，記下收到的訊息 */
    static class FakeWonder implements AiModel {
        final Deque<String> replies = new ArrayDeque<>();
        final List<String> received = new ArrayList<>();

        @Override
        public Reply call(String conversationId, String userText, Image image) {
            received.add(userText);
            return new Reply(replies.removeFirst(), 5000, 500, "fake-wonder");
        }

        @Override
        public void forget(String conversationId) {}
    }

    private final FakeSpark spark = new FakeSpark();
    private final FakeWonder wonder = new FakeWonder();
    private final List<String> usage = Collections.synchronizedList(new ArrayList<>());
    private final DirectorJobs jobs = new DirectorJobs(spark, wonder, Runnable::run, (t, m, in, out) -> usage.add(t + ":" + m));

    private final DirectorJobs.StartRequest req = new DirectorJobs.StartRequest("talk.mp4", 200, 2, List.of(new DirectorJobs.Scene("board-float", "Floating board")));

    private DirectorJobs.SegmentMeta meta(double start, double end, String wordId) {
        return new DirectorJobs.SegmentMeta(start, end, List.of(new DirectorJobs.Word(wordId, start + 1, "hello")));
    }

    @Test
    void 兩段都回來才統籌_報告的時間換成素材時間_建議合格() {
        wonder.replies.add("{\"suggestions\":[{\"kind\":\"mask\",\"start\":105,\"end\":108,\"reason\":\"API key on screen\",\"target\":\"API key\"},{\"kind\":\"fix\",\"start\":1,\"end\":2,\"reason\":\"r\",\"wordIds\":[\"m:w1\"],\"text\":\"Java\"}]}");
        String id = jobs.start(7, req);
        jobs.addSegment(7, id, 0, meta(0, 100, "m:w1"), new byte[3]);
        assertThat(jobs.view(7, id).status()).isEqualTo("collecting");
        jobs.addSegment(7, id, 1, meta(100, 200, "m:w9"), new byte[3]);
        DirectorJobs.View v = jobs.view(7, id);
        assertThat(v.status()).isEqualTo("done");
        assertThat(v.segmentsDone()).isEqualTo(2);
        assertThat(v.suggestions()).extracting(DirectorRules.Suggestion::kind).containsExactly("fix", "mask");
        // Wonder 收到的是素材時間：第二段的重講在 102～104 秒
        assertThat(wonder.received.get(0)).contains("\"start\":102").contains("board-float");
        assertThat(spark.transcripts.get(1)).contains("m:w9").contains("[1.0]");
        assertThat(usage).containsExactly("7:fake-spark", "7:fake-spark", "7:fake-wonder");
    }

    @Test
    void Wonder_不合格就帶錯誤重問一次() {
        wonder.replies.add("{\"suggestions\":[{\"kind\":\"camera\",\"start\":1,\"end\":5,\"reason\":\"r\",\"scene\":\"moon\",\"description\":\"d\"}]}");
        wonder.replies.add("{\"suggestions\":[{\"kind\":\"camera\",\"start\":1,\"end\":5,\"reason\":\"r\",\"scene\":\"board-float\",\"description\":\"d\"}]}");
        String id = jobs.start(7, req);
        jobs.addSegment(7, id, 0, meta(0, 100, "m:w1"), new byte[3]);
        jobs.addSegment(7, id, 1, meta(100, 200, "m:w2"), new byte[3]);
        assertThat(wonder.received).hasSize(2);
        assertThat(wonder.received.get(1)).contains("moon");
        assertThat(jobs.view(7, id).suggestions()).hasSize(1);
    }

    @Test
    void 一段失敗_其他段照樣統籌_記失敗段數() {
        spark.failSecond = true;
        wonder.replies.add("{\"suggestions\":[]}");
        String id = jobs.start(7, req);
        jobs.addSegment(7, id, 0, meta(0, 100, "m:w1"), new byte[3]);
        jobs.addSegment(7, id, 1, meta(100, 200, "m:w9"), new byte[3]);
        DirectorJobs.View v = jobs.view(7, id);
        assertThat(v.status()).isEqualTo("done");
        assertThat(v.segmentsFailed()).isEqualTo(1);
    }

    @Test
    void 全部失敗就失敗_取消_權杖隔離_段號不對() {
        DirectorJobs.StartRequest one = new DirectorJobs.StartRequest("a", 100, 1, List.of());
        spark.failSecond = true;
        String id = jobs.start(7, one);
        jobs.addSegment(7, id, 0, meta(0, 100, "m:w9"), new byte[3]);
        assertThat(jobs.view(7, id)).extracting(DirectorJobs.View::status, DirectorJobs.View::error).containsExactly("failed", "segments-failed");
        String id2 = jobs.start(7, req);
        jobs.cancel(7, id2);
        assertThat(jobs.view(7, id2).status()).isEqualTo("cancelled");
        assertThatThrownBy(() -> jobs.view(8, id2)).isInstanceOf(DirectorJobs.NotFoundException.class);
        String id3 = jobs.start(7, req);
        assertThatThrownBy(() -> jobs.addSegment(7, id3, 5, meta(0, 1, "x"), new byte[3])).isInstanceOf(IllegalArgumentException.class);
    }
}
