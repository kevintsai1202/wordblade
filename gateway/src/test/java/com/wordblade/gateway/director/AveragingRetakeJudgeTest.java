package com.wordblade.gateway.director;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.within;

import java.util.ArrayDeque;
import java.util.Deque;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Jev 問 3 次取平均（2026-10-31 開發者決定；同一請求連送有 ±0.03 的差異）：四個機率與句子完整度都平均、tokens 加總。 */
class AveragingRetakeJudgeTest {

    @Test
    void 一對句子問三次_機率平均_tokens加總() {
        Deque<DirectorJobs.RetakeVerdict> replies = new ArrayDeque<>(List.of(
                new DirectorJobs.RetakeVerdict(0.61, 0.5, 0.2, 0.3, 500, "jev-1.14.0"),
                new DirectorJobs.RetakeVerdict(0.64, 0.6, 0.1, 0.3, 500, "jev-1.14.0"),
                new DirectorJobs.RetakeVerdict(0.67, 0.4, 0.3, 0.6, 500, "jev-1.14.0")));
        DirectorJobs.RetakeJudge inner = (earlier, later) -> replies.removeFirst();
        DirectorJobs.RetakeVerdict v = new AveragingRetakeJudge(inner, 3).judge("a", "b");
        assertThat(v.retake()).isCloseTo(0.64, within(1e-9));
        assertThat(v.falseStart()).isCloseTo(0.5, within(1e-9));
        assertThat(v.supplement()).isCloseTo(0.2, within(1e-9));
        assertThat(v.complete()).isCloseTo(0.4, within(1e-9));
        assertThat(v.inputTokens()).isEqualTo(1500);
        assertThat(v.model()).isEqualTo("jev-1.14.0");
        assertThat(replies).isEmpty();
    }

    @Test
    void 句子完整度也問三次平均_不支援就回_null() {
        Deque<DirectorJobs.Completeness> replies = new ArrayDeque<>(List.of(
                new DirectorJobs.Completeness(List.of(0.1, 0.9), 300, "jev"),
                new DirectorJobs.Completeness(List.of(0.2, 0.8), 300, "jev"),
                new DirectorJobs.Completeness(List.of(0.3, 0.7), 300, "jev")));
        DirectorJobs.RetakeJudge inner = new DirectorJobs.RetakeJudge() {
            @Override
            public DirectorJobs.RetakeVerdict judge(String earlier, String later) {
                throw new UnsupportedOperationException();
            }

            @Override
            public DirectorJobs.Completeness completeness(List<String> sentences) {
                return replies.removeFirst();
            }
        };
        DirectorJobs.Completeness c = new AveragingRetakeJudge(inner, 3).completeness(List.of("x", "y"));
        assertThat(c.probabilities().get(0)).isCloseTo(0.2, within(1e-9));
        assertThat(c.probabilities().get(1)).isCloseTo(0.8, within(1e-9));
        assertThat(c.inputTokens()).isEqualTo(900);
        DirectorJobs.RetakeJudge noCompleteness = (e, l) -> null;
        assertThat(new AveragingRetakeJudge(noCompleteness, 3).completeness(List.of("x"))).isNull();
    }
}
