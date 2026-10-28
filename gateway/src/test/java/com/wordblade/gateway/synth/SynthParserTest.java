package com.wordblade.gateway.synth;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.wordblade.gateway.ai.AiError;
import com.wordblade.gateway.ai.AiSchemaException;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.DynamicTest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * AI 音效與配樂回應的解析與驗證（spec §5.15、D27）。
 * 前端的 src/audio/synth/validationCases.json 與內建範本兩邊都跑，確保閘道與前端的規則一致。
 */
class SynthParserTest {

    private final JsonMapper json = JsonMapper.builder().build();
    private final SynthParser parser = SynthParser.fromResources(json);

    static final String BEEP = """
            {"length":0.5,"voices":[{"source":{"type":"osc","wave":"sine","freq":880},"env":{"attack":0.01,"decay":0.1,"sustain":0.5,"release":0.1}}]}""";
    static final String PAD = """
            {"bpm":120,"bars":2,"chords":["Am","F"],"parts":[{"role":"pad","voice":{"source":{"type":"osc","wave":"triangle"},
             "env":{"attack":0.1,"decay":0,"sustain":1,"release":0.3}},"notes":[{"at":0,"len":4,"chord":0}]}]}""";

    /** 前端的檔案（測試從 gateway/ 執行） */
    private JsonNode frontend(String name) throws IOException {
        return json.readTree(Files.readString(Path.of("..", "src", "audio", "synth", name)));
    }

    /** 斷言回應被擋下，且某則錯誤訊息包含 hint */
    private void rejects(Runnable call, String hint) {
        assertThatThrownBy(call::run)
                .isInstanceOf(AiSchemaException.class)
                .satisfies(e -> assertThat(((AiSchemaException) e).errors()).extracting(AiError::message).anyMatch(m -> m.contains(hint)));
    }

    @TestFactory
    List<DynamicTest> 共用的驗證案例和前端一致() throws IOException {
        return java.util.stream.StreamSupport.stream(frontend("validationCases.json").spliterator(), false).map(c -> DynamicTest.dynamicTest(c.get("name").asString(), () -> {
            List<String> errors = c.get("kind").asString().equals("sound") ? parser.soundErrors(c.get("spec")).errors() : parser.musicErrors(c.get("spec")).errors();
            if (c.get("error").isNull()) assertThat(errors).isEmpty();
            else assertThat(String.join("\n", errors)).contains(c.get("error").asString());
        })).toList();
    }

    @Test
    void 內建範本都通過() throws IOException {
        JsonNode data = frontend("templateData.json");
        for (JsonNode t : data.get("sound")) assertThat(parser.soundErrors(t.get("spec")).errors()).as(t.get("id").asString()).isEmpty();
        for (JsonNode t : data.get("music")) assertThat(parser.musicErrors(t.get("spec")).errors()).as(t.get("id").asString()).isEmpty();
    }

    @Test
    void 拒答只收off_topic() {
        assertThat(parser.parseSound("{\"refused\":\"off-topic\"}", 0.5).refusal()).isEqualTo("off-topic");
        rejects(() -> parser.parseSound("{\"refused\":\"unsafe\"}", 0.5), "refused");
    }

    @Test
    void 音效_容忍圍欄與多餘欄位_回清理過的spec() {
        SynthParser.Result r = parser.parseSound("```json\n" + BEEP.replace("{\"length\"", "{\"title\":\"beep\",\"length\"") + "\n```", 0.5);
        assertThat(r.refusal()).isNull();
        assertThat(r.spec().has("title")).isFalse();
        assertThat(r.spec().get("voices").get(0).get("source").get("freq").asDouble()).isEqualTo(880);
    }

    @Test
    void 音效_長度要等於要求的長度() {
        rejects(() -> parser.parseSound(BEEP, 1.0), "length 要是使用者要求的 1 秒");
    }

    @Test
    void 配樂_小節數要等於要求的小節數() {
        assertThat(parser.parseMusic(PAD, 2).spec().get("bars").asInt()).isEqualTo(2);
        rejects(() -> parser.parseMusic(PAD, 8), "bars 要是使用者要求的 8");
    }

    @Test
    void 不是JSON() {
        rejects(() -> parser.parseSound("here is your sound", 0.5), "不是 JSON 物件");
    }
}
