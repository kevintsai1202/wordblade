package com.wordblade.gateway.director;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * 程式決定的剪（docs/plan-10-31-director4.md）：片頭空白、片尾空白、Jev 確認的重講——不交給規劃者決定，同樣的輸入每次一樣。
 * 重疊或相連的重講合成一段，只留最後一次重講；片尾只講一聲的孤立詞（Yeah）不算講話。
 */
class FixedCutsTest {

    /** Jev 確認過的候選 */
    private static DirectorJobs.JudgedRetake verified(double start, double end, double p) {
        return new DirectorJobs.JudgedRetake(new RetakeFinder.Candidate("r", start, end, "earlier", "later", 0.5), new DirectorJobs.RetakeVerdict(p, 0, 0, 0.9, 500, "jev"));
    }

    @Test
    void 中文錄影_片頭空白與重疊的重講合成一段_只留最後一次() {
        List<DirectorJobs.Word> w = new ArrayList<>(RetakeFinderTest.lecture());
        w.add(new DirectorJobs.Word("z", 127, "Yeah"));
        List<DirectorRules.Suggestion> cuts = FixedCuts.build(w, 128.5, List.of(verified(19, 23.5, 0.9), verified(23.5, 66, 0.8), verified(40, 80, 0.3)));
        assertThat(cuts).extracting(DirectorRules.Suggestion::kind).containsOnly("cut");
        assertThat(cuts).extracting(c -> c.payload().get("reason")).containsExactly("head", "retake", "tail");
        assertThat(cuts.get(0).start()).isEqualTo(0.0);
        assertThat(cuts.get(0).end()).isEqualTo(18.7);
        assertThat(cuts.get(1).start()).isEqualTo(19.0);
        assertThat(cuts.get(1).end()).isEqualTo(66.0);
        // 片尾：最後一句（80 秒那句）講完之後；127 秒那聲孤立的 Yeah 不算
        assertThat(cuts.get(2).start()).isGreaterThan(84.0).isLessThan(86.0);
        assertThat(cuts.get(2).end()).isEqualTo(128.5);
        assertThat(cuts).extracting(DirectorRules.Suggestion::id).containsExactly("f1", "f2", "f3");
        assertThat(cuts).allMatch(c -> !c.purpose().isBlank());
    }

    @Test
    void 沒有空白也沒有確認的重講就不剪_未確認的候選不剪() {
        List<DirectorJobs.Word> w = RetakeFinderTest.zh(0.5, "我們開始吧今天要介紹的是框架", "a");
        DirectorJobs.JudgedRetake unverified = new DirectorJobs.JudgedRetake(new RetakeFinder.Candidate("r", 0.5, 2, "a", "b", 0.5), null);
        assertThat(FixedCuts.build(w, 4.5, List.of(unverified))).isEmpty();
    }

    @Test
    void 規劃者的剪和程式的剪重疊_併成一段_程式的優先() {
        List<DirectorRules.Suggestion> fixed = FixedCuts.build(RetakeFinderTest.lecture(), 85, List.of(verified(23.5, 66, 0.8)));
        DirectorRules.Suggestion planned = new DirectorRules.Suggestion("i1", "cut", 20, 30, "p", new java.util.LinkedHashMap<>(java.util.Map.of("reason", "retake")),
                "p", "q", 0, null, null);
        DirectorRules.Suggestion zoom = new DirectorRules.Suggestion("i2", "zoom", 70, 78, "p", java.util.Map.of(), "p", "q", 0, null, "p1");
        List<DirectorRules.Suggestion> out = FixedCuts.merge(fixed, List.of(planned, zoom));
        assertThat(out).extracting(DirectorRules.Suggestion::id).containsExactly("f1", "f2", "i2");
        assertThat(out.get(1).start()).isEqualTo(20.0);
        assertThat(out.get(1).end()).isEqualTo(66.0);
    }

    /** 一個候選與 Jev 的判斷（重講、放棄的碎片、補充、後面講完整） */
    private static DirectorJobs.JudgedRetake judged(double start, double end, double retake, double falseStart, double supplement, double complete) {
        return new DirectorJobs.JudgedRetake(new RetakeFinder.Candidate("r", start, end, "earlier", "later", 0.1),
                new DirectorJobs.RetakeVerdict(retake, falseStart, supplement, complete, 500, "jev"));
    }

    @Test
    void 放棄的碎片也剪_最後一次沒講完整就不自動剪() {
        List<DirectorJobs.Word> w = RetakeFinderTest.lecture();
        // 60.9 秒的「我們要」是放棄的碎片（falseStart 0.74）→ 剪；另一串不太確定的重講（0.65）最後一次沒講完整 → 不剪
        List<DirectorRules.Suggestion> cuts = FixedCuts.build(w, 85, List.of(judged(60.9, 66, 0.16, 0.74, 0.1, 0.9), judged(30, 40, 0.65, 0.2, 0.1, 0.2)));
        assertThat(cuts).filteredOn(c -> "retake".equals(c.payload().get("reason"))).singleElement().satisfies(c -> {
            assertThat(c.start()).isEqualTo(60.9);
            assertThat(c.end()).isEqualTo(66.0);
        });
    }

    @Test
    void 補充_兩段都留_列成提醒項目() {
        List<DirectorRules.Suggestion> notes = FixedCuts.notes(List.of(judged(30, 67, 0.05, 0.1, 0.95, 0.9), judged(10, 20, 0.8, 0.1, 0.7, 0.9)));
        assertThat(notes).singleElement().satisfies(n -> {
            assertThat(n.id()).isEqualTo("n1");
            assertThat(n.kind()).isEqualTo("note");
            assertThat(n.start()).isEqualTo(67.0);
            assertThat(n.payload()).containsEntry("earlierStart", 30.0).containsEntry("relation", "supplement");
            assertThat(n.purpose()).contains("67.0").contains("30.0");
        });
    }

    /** 候選與 Jev 的判斷，加上前面那句自己講完整的機率 */
    private static DirectorJobs.JudgedRetake logged(double start, double end, double retake, double falseStart, double complete, double earlierComplete) {
        return new DirectorJobs.JudgedRetake(new RetakeFinder.Candidate("r", start, end, "earlier", "later", 0.3),
                new DirectorJobs.RetakeVerdict(retake, falseStart, 0.2, complete, 500, "jev"), earlierComplete);
    }

    @Test
    void 實測機率_很確定的重講不看保留那次完不完整_不完整的碎片門檻零點五_剪到最後一次重錄() {
        // logs/director-rel-1-gateway.log（OBS 中文錄影）
        List<DirectorJobs.JudgedRetake> log = List.of(
                logged(19, 23.5, 0.72, 0.50, 0.20, 0.12), logged(19, 60.9, 0.79, 0.64, 0.72, 0.12), logged(19, 66.4, 0.77, 0.64, 0.22, 0.12),
                logged(23.5, 60.9, 0.72, 0.62, 0.72, 0.23), logged(23.5, 66.4, 0.76, 0.67, 0.28, 0.23), logged(60.9, 66.4, 0.20, 0.55, 0.31, 0.06),
                logged(23.5, 73.9, 0.12, 0.24, 0.10, 0.23), logged(73.9, 127.7, 0.10, 0.57, 0.19, 0.15));
        assertThat(log.get(5).verdict().isRetake()).isFalse();
        assertThat(log.get(5).isRetake()).isTrue();
        assertThat(log.get(7).isRetake()).isFalse();
        List<DirectorRules.Suggestion> cuts = FixedCuts.build(RetakeFinderTest.lecture(), 85, log);
        assertThat(cuts).filteredOn(c -> "retake".equals(c.payload().get("reason"))).singleElement().satisfies(c -> {
            assertThat(c.start()).isEqualTo(19.0);
            assertThat(c.end()).isEqualTo(66.4);
        });
    }

    @Test
    void 不太確定的重講_保留那次沒講完整就不剪() {
        List<DirectorRules.Suggestion> cuts = FixedCuts.build(RetakeFinderTest.lecture(), 85, List.of(logged(30, 40, 0.65, 0.3, 0.2, 0.9)));
        assertThat(cuts).noneMatch(c -> "retake".equals(c.payload().get("reason")));
    }
}
