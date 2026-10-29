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

/**
 * AI 導演工作（docs/plan-10-29-director2.md）：逐段交給 Spark（理解；時間換成素材時間）→ 全部回來交給 Wonder 規劃剪輯腳本（不合格回饋一次）→ planned
 * → 前端送縮圖總表 → 另一個 Wonder（審查者，獨立對話、只看腳本、逐字稿與總表）逐項判定 → 有退回就讓規劃者改一輪 → done。
 * 也測段落失敗、取消、權杖隔離。
 */
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
                    {"summary":"s","chapters":[{"title":"Start","start":0}],"retakes":[{"start":2,"end":4,"reason":"stumble"}],
                     "privacy":[{"start":5,"end":8,"target":"API key","x":0.1,"y":0.1,"w":0.3,"h":0.05}],
                     "highlights":[],"activities":[{"id":"a0","what":"scrolling","zoom":false},{"id":"a100","what":"typing code in index.js","zoom":true}],
                     "misheard":[{"wordIds":["m:w1"],"heard":"Jav","correct":"Java"}]}""", 1000, 100, "fake-spark");
        }
    }

    /** 假 Wonder：依序回排好的回應，記下收到的訊息、對話 id 與有沒有附圖 */
    static class FakeWonder implements AiModel {
        final Deque<String> replies = new ArrayDeque<>();
        final List<String> received = new ArrayList<>();
        final List<String> conversations = new ArrayList<>();
        final List<Boolean> images = new ArrayList<>();
        final String name;

        FakeWonder(String name) {
            this.name = name;
        }

        @Override
        public Reply call(String conversationId, String userText, Image image) {
            received.add(userText);
            conversations.add(conversationId);
            images.add(image != null);
            return new Reply(replies.removeFirst(), 5000, 500, name);
        }

        @Override
        public void forget(String conversationId) {}
    }

    private final FakeSpark spark = new FakeSpark();
    private final FakeWonder planner = new FakeWonder("fake-planner");
    private final FakeWonder reviewer = new FakeWonder("fake-reviewer");
    private final List<String> usage = Collections.synchronizedList(new ArrayList<>());
    private final DirectorJobs jobs = new DirectorJobs(spark, planner, reviewer, Runnable::run, (t, m, in, out) -> usage.add(t + ":" + m));

    private final DirectorJobs.StartRequest req = new DirectorJobs.StartRequest("talk.mp4", 200, 2, List.of(new DirectorJobs.Scene("desk-reveal", "Desk")));

    private DirectorJobs.SegmentMeta meta(double start, double end, String wordId) {
        return new DirectorJobs.SegmentMeta(start, end, List.of(new DirectorJobs.Word(wordId, start + 1, "hello")),
                List.of(new DirectorJobs.Activity("a" + (int) start, start + 10, start + 20, 0.5, 0.3, 0.4, 0.2)));
    }

    /** 規劃者的腳本：兩章、一個剪、一個轉場（在 100 秒的交界）、一個特效 */
    private static final String SCRIPT = """
            {"chapters":[{"title":"Setup","start":0,"end":100},{"title":"Code","start":100,"end":200}],
             "items":[
              {"id":"i1","kind":"cut","start":102,"end":104,"chapter":1,"purpose":"Remove the stumble","quote":"sorry"},
              {"id":"i2","kind":"transition","start":98,"end":102,"chapter":1,"purpose":"Into the code part","quote":"Now let's write it","scene":"desk-reveal"},
              {"id":"i3","kind":"effect","start":150,"end":154,"chapter":1,"purpose":"Celebrate","quote":"it works","description":"Confetti"}
             ]}""";

    /** 送兩段（第二段的詞 id 是 w2） */
    private String twoSegments() {
        String id = jobs.start(7, req);
        jobs.addSegment(7, id, 0, meta(0, 100, "m:w1"), new byte[3]);
        jobs.addSegment(7, id, 1, meta(100, 200, "m:w2"), new byte[3]);
        return id;
    }

    @Test
    void 兩段都回來才規劃_報告與活動區換成素材時間_規劃完停在_planned() {
        planner.replies.add(SCRIPT);
        String id = jobs.start(7, req);
        jobs.addSegment(7, id, 0, meta(0, 100, "m:w1"), new byte[3]);
        assertThat(jobs.view(7, id).status()).isEqualTo("collecting");
        jobs.addSegment(7, id, 1, meta(100, 200, "m:w2"), new byte[3]);
        DirectorJobs.View v = jobs.view(7, id);
        assertThat(v.status()).isEqualTo("planned");
        assertThat(v.chapters()).extracting(DirectorRules.Chapter::title).containsExactly("Setup", "Code");
        assertThat(v.suggestions()).extracting(DirectorRules.Suggestion::id).containsExactly("i2", "i1", "i3");
        // 規劃者收到的是素材時間：第二段的重講在 102～104 秒、活動區 a100 在 110～120 秒＋ Spark 確認的內容
        assertThat(planner.received.get(0)).contains("\"start\":102").contains("desk-reveal").contains("\"id\":\"a100\"").contains("typing code in index.js");
        // Spark 收到的逐字稿帶著這段的活動區（段內秒數）
        assertThat(spark.transcripts.get(1)).contains("m:w2").contains("a100").contains("[10.0–20.0]");
        assertThat(usage).containsExactly("7:fake-spark", "7:fake-spark", "7:fake-planner");
    }

    @Test
    void 審查全部通過_審查者是獨立對話_看得到腳本逐字稿與總表_規劃者不再被叫() {
        planner.replies.add(SCRIPT);
        reviewer.replies.add("{\"verdicts\":[{\"id\":\"i1\",\"verdict\":\"keep\",\"note\":\"ok\"},{\"id\":\"i2\",\"verdict\":\"keep\",\"note\":\"ok\"},{\"id\":\"i3\",\"verdict\":\"keep\",\"note\":\"ok\"}],\"missing\":[]}");
        String id = twoSegments();
        jobs.review(7, id, new AiModel.Image("image/jpeg", new byte[] {1}));
        DirectorJobs.View v = jobs.view(7, id);
        assertThat(v.status()).isEqualTo("done");
        assertThat(v.suggestions()).allMatch(s -> s.review() != null && s.review().verdict().equals("keep"));
        assertThat(v.removed()).isEmpty();
        assertThat(reviewer.conversations.get(0)).isNotEqualTo(planner.conversations.get(0));
        assertThat(reviewer.images).containsExactly(true);
        assertThat(reviewer.received.get(0)).contains("\"id\":\"i2\"").contains("Now let's write it").contains("hello").contains("Setup");
        assertThat(planner.received).hasSize(1);
        assertThat(usage).contains("7:fake-reviewer");
    }

    @Test
    void 審查刪掉一項_要求修改一項_規劃者依意見改一輪_刪掉的列在_removed() {
        planner.replies.add(SCRIPT);
        reviewer.replies.add("""
                {"verdicts":[{"id":"i1","verdict":"keep","note":"ok"},{"id":"i2","verdict":"revise","note":"Start it on the sentence, at 99 s"},
                 {"id":"i3","verdict":"drop","note":"Nothing on screen to celebrate"}],"missing":[{"kind":"mask","start":5,"end":8,"note":"API key not hidden"}]}""");
        planner.replies.add("""
                {"chapters":[{"title":"Setup","start":0,"end":100},{"title":"Code","start":100,"end":200}],
                 "items":[
                  {"id":"i1","kind":"cut","start":102,"end":104,"purpose":"Remove the stumble","quote":"sorry"},
                  {"id":"i2","kind":"transition","start":99,"end":103,"purpose":"Into the code part","quote":"Now let's write it","scene":"desk-reveal"},
                  {"id":"i4","kind":"mask","start":5,"end":8,"purpose":"Hide the key","target":"API key"}
                 ]}""");
        String id = twoSegments();
        jobs.review(7, id, null);
        DirectorJobs.View v = jobs.view(7, id);
        assertThat(v.status()).isEqualTo("done");
        assertThat(planner.received.get(1)).contains("Start it on the sentence").contains("Nothing on screen to celebrate").contains("API key not hidden");
        assertThat(planner.conversations.get(1)).isEqualTo(planner.conversations.get(0));
        assertThat(v.suggestions()).extracting(DirectorRules.Suggestion::id).containsExactly("i4", "i2", "i1");
        assertThat(v.suggestions().stream().filter(s -> s.id().equals("i2")).findFirst().orElseThrow().review())
                .isEqualTo(new DirectorRules.Review("revised", "Start it on the sentence, at 99 s"));
        assertThat(v.suggestions().stream().filter(s -> s.id().equals("i4")).findFirst().orElseThrow().review().verdict()).isEqualTo("added");
        assertThat(v.removed()).extracting(DirectorRules.Suggestion::id).containsExactly("i3");
        assertThat(v.removed().get(0).review()).isEqualTo(new DirectorRules.Review("drop", "Nothing on screen to celebrate"));
        assertThat(reviewer.images).containsExactly(false);
    }

    @Test
    void 規劃不合格就帶錯誤重問一次_還沒規劃完不能審查() {
        planner.replies.add("{\"chapters\":[{\"title\":\"A\",\"start\":0,\"end\":200}],\"items\":[{\"id\":\"i1\",\"kind\":\"transition\",\"start\":1,\"end\":4,\"purpose\":\"p\",\"quote\":\"q\",\"scene\":\"moon\"}]}");
        planner.replies.add("{\"chapters\":[{\"title\":\"A\",\"start\":0,\"end\":200}],\"items\":[{\"id\":\"i1\",\"kind\":\"cut\",\"start\":1,\"end\":4,\"purpose\":\"p\",\"quote\":\"q\"}]}");
        String id = jobs.start(7, req);
        assertThatThrownBy(() -> jobs.review(7, id, null)).isInstanceOf(IllegalArgumentException.class);
        jobs.addSegment(7, id, 0, meta(0, 100, "m:w1"), new byte[3]);
        jobs.addSegment(7, id, 1, meta(100, 200, "m:w2"), new byte[3]);
        assertThat(planner.received).hasSize(2);
        assertThat(planner.received.get(1)).contains("moon");
        assertThat(jobs.view(7, id).suggestions()).hasSize(1);
    }

    @Test
    void 一段失敗_其他段照樣規劃_記失敗段數() {
        spark.failSecond = true;
        planner.replies.add("{\"chapters\":[{\"title\":\"A\",\"start\":0,\"end\":200}],\"items\":[]}");
        String id = jobs.start(7, req);
        jobs.addSegment(7, id, 0, meta(0, 100, "m:w1"), new byte[3]);
        jobs.addSegment(7, id, 1, meta(100, 200, "m:w9"), new byte[3]);
        DirectorJobs.View v = jobs.view(7, id);
        assertThat(v.status()).isEqualTo("planned");
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
