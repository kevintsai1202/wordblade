package com.wordblade.gateway.sam;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** Meta SAM 串流的讀法（2026-10-28 實測串流 fosdem-person.sse）、逐格文字切行、名詞片語驗證。 */
class SamSseTest {

    private final JsonMapper json = JsonMapper.builder().build();

    @Test
    void 實測串流_40個delta_處理格數50_讀到DONE() throws Exception {
        List<String> deltas = new ArrayList<>();
        try (var in = getClass().getResourceAsStream("/sam/fosdem-person.sse")) {
            long frames = SamSse.read(new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8)), json, deltas::add, () -> false);
            assertThat(frames).isEqualTo(50);
        }
        assertThat(deltas).hasSize(40);
        assertThat(deltas.get(0)).startsWith("<0f>0<|box;").endsWith("|>\n");
    }

    @Test
    void 錯誤事件_或沒有結尾就斷_都算上游錯誤() {
        String error = "data: {\"type\":\"response.created\"}\n\ndata: {\"type\":\"response.failed\",\"response\":{}}\n\n";
        assertThatThrownBy(() -> SamSse.read(new BufferedReader(new StringReader(error)), json, d -> { }, () -> false))
                .isInstanceOf(SamUpstreamException.class);
        String cut = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"<0f>\"}\n\n";
        assertThatThrownBy(() -> SamSse.read(new BufferedReader(new StringReader(cut)), json, d -> { }, () -> false))
                .isInstanceOf(SamUpstreamException.class);
    }

    @Test
    void 取消時停止讀() {
        String body = "data: {\"type\":\"response.output_text.delta\",\"delta\":\"<0f>0<|box;x1=1;y1=1;x2=2;y2=2;w=9;h=9|>\\n\"}\n\n";
        assertThatThrownBy(() -> SamSse.read(new BufferedReader(new StringReader(body)), json, d -> { }, () -> true))
                .isInstanceOf(SamCancelledException.class);
    }

    @Test
    void 切行_任意位置切開_只回完整的行() {
        String text = "<0f>0<|box;a|>\n<1f>0<|box;b|>\r\n<2f>";
        for (int cut = 1; cut < text.length(); cut++) {
            SamLines lines = new SamLines();
            List<String> got = new ArrayList<>(lines.feed(text.substring(0, cut)));
            got.addAll(lines.feed(text.substring(cut)));
            assertThat(got).as("cut %d", cut).containsExactly("<0f>0<|box;a|>", "<1f>0<|box;b|>");
            assertThat(lines.rest()).isEqualTo("<2f>");
        }
    }

    @Test
    void 名詞片語驗證() {
        assertThat(SamPhrase.valid("human face")).isTrue();
        assertThat(SamPhrase.valid("license plate")).isTrue();
        assertThat(SamPhrase.valid("API key")).isTrue();
        assertThat(SamPhrase.valid("a")).isFalse();
        assertThat(SamPhrase.valid("the of")).isFalse();
        assertThat(SamPhrase.valid("人臉")).isFalse();
        assertThat(SamPhrase.valid("one two three four five six seven")).isFalse();
        assertThat(SamPhrase.valid("face; drop table")).isFalse();
    }
}
