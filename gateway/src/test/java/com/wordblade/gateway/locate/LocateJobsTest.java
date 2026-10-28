package com.wordblade.gateway.locate;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.wordblade.gateway.ai.AiModel;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import org.junit.jupiter.api.Test;

/** 螢幕文字定位工作：Spark 回每格的框 → 夾在 0～1、超出範圍的格丟掉、沒回的格當作沒有；JSON 讀不出重問一次；目標與張數檢查；權杖隔離。 */
class LocateJobsTest {

    /** 假 Spark：依序回排好的回應 */
    static class FakeSpark implements LocateJobs.ImageModel {
        final Deque<String> replies = new ArrayDeque<>();
        final List<String> targets = new ArrayList<>();

        @Override
        public AiModel.Reply analyze(String target, List<byte[]> jpegs) {
            targets.add(target + ":" + jpegs.size());
            return new AiModel.Reply(replies.removeFirst(), 3000, 500, "fake-spark");
        }
    }

    private final FakeSpark spark = new FakeSpark();
    private final List<String> usage = new ArrayList<>();
    private final LocateJobs jobs = new LocateJobs(spark, Runnable::run, (t, m, in, out) -> usage.add(t + ":" + m));

    private List<LocateJobs.Frame> frames(double... times) {
        List<LocateJobs.Frame> out = new ArrayList<>();
        for (double t : times) out.add(new LocateJobs.Frame(t, new byte[] {1}));
        return out;
    }

    @Test
    void 回每格的框_夾住範圍_超出的格丟掉_沒回的格是空的() {
        spark.replies.add("""
                {"frames":[{"index":0,"items":[{"text":"sk-proj-4","x":0.298,"y":0.076,"w":0.035,"h":0.022}]},
                 {"index":2,"items":[{"text":"sk","x":0.9,"y":-0.1,"w":0.5,"h":0.05}]},
                 {"index":7,"items":[{"text":"x","x":0.1,"y":0.1,"w":0.1,"h":0.1}]}]}""");
        String id = jobs.start(7, "API key or secret token", frames(32, 33, 34));
        LocateJobs.View v = jobs.view(7, id);
        assertThat(v.status()).isEqualTo("done");
        assertThat(v.frames()).extracting(LocateJobs.FrameResult::t).containsExactly(32.0, 33.0, 34.0);
        assertThat(v.frames().get(0).items()).hasSize(1);
        assertThat(v.frames().get(1).items()).isEmpty();
        LocateJobs.Item clamped = v.frames().get(2).items().get(0);
        assertThat(clamped.y()).isEqualTo(0.0);
        assertThat(clamped.x() + clamped.w()).isLessThanOrEqualTo(1.0);
        assertThat(spark.targets).containsExactly("API key or secret token:3");
        assertThat(usage).containsExactly("7:fake-spark");
    }

    @Test
    void JSON_讀不出來重問一次_兩次都不行就失敗() {
        spark.replies.add("not json");
        spark.replies.add("{\"frames\":[]}");
        String id = jobs.start(7, "password", frames(1));
        assertThat(jobs.view(7, id).status()).isEqualTo("done");
        spark.replies.add("bad");
        spark.replies.add("bad again");
        String id2 = jobs.start(7, "password", frames(1));
        assertThat(jobs.view(7, id2)).extracting(LocateJobs.View::status, LocateJobs.View::error).containsExactly("failed", "invalid-response");
    }

    @Test
    void 目標與張數檢查_權杖隔離() {
        assertThatThrownBy(() -> jobs.start(7, "", frames(1))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> jobs.start(7, "a\nb", frames(1))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> jobs.start(7, "password", frames())).isInstanceOf(IllegalArgumentException.class);
        double[] many = new double[LocateJobs.MAX_FRAMES + 1];
        assertThatThrownBy(() -> jobs.start(7, "password", frames(many))).isInstanceOf(IllegalArgumentException.class);
        spark.replies.add("{\"frames\":[]}");
        String id = jobs.start(7, "password", frames(1));
        assertThatThrownBy(() -> jobs.view(8, id)).isInstanceOf(LocateJobs.NotFoundException.class);
    }
}
