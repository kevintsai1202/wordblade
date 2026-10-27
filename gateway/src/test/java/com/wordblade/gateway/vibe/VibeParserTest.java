package com.wordblade.gateway.vibe;

import com.wordblade.gateway.ai.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** 模型回應的解析與結構檢查（移植原專案 anim_ai.parse_response 的閘道這一半；插件程式的驗證在桌面沙盒）。 */
class VibeParserTest {

    private final VibeParser parser = new VibeParser(JsonMapper.builder().build());

    @Test
    void 拒答只回代碼_未知代碼當成離題() {
        assertThat(parser.parse("{\"refused\": true, \"code\": \"unsafe\"}").refusal()).isEqualTo("unsafe");
        assertThat(parser.parse("{\"refused\": true, \"code\": \"please help\"}").refusal()).isEqualTo("off-topic");
    }

    @Test
    void 產生_程式碼陣列接成字串_只留結構化欄位() {
        String text = """
                ```json
                {"refused": false, "mode": "new", "explanation": "I made stars",
                 "anim": {"title": "Stars", "layers": [{"component": "#0", "params": {}, "start": 0, "end": null}], "sounds": []},
                 "components": [{"kind": "visual", "name": "Stars", "params": {}, "code": ["function draw(g) {", "}"]}],
                 "target": {"phrase": "the button!!"}}
                ```""";
        VibeParser.Parsed p = parser.parse(text);
        assertThat(p.refusal()).isNull();
        assertThat(p.mode()).isEqualTo("new");
        assertThat(p.components().get(0).get("code").asString()).isEqualTo("function draw(g) {\n}");
        assertThat(p.anim().get("title").asString()).isEqualTo("Stars");
        assertThat(p.targetPhrase()).isEqualTo("the button");
        // 模型的自由文字（explanation）不往下傳
        assertThat(p.toString()).doesNotContain("I made stars");
    }

    @Test
    void 不是JSON_回饋json階段的錯誤() {
        assertThatThrownBy(() -> parser.parse("Sure! Here is your effect."))
                .isInstanceOf(AiSchemaException.class)
                .satisfies(e -> assertThat(((AiSchemaException) e).errors()).extracting(AiError::stage).containsExactly("json"));
    }

    @Test
    void 結構錯誤_mode_圖層數_引用() {
        assertThatThrownBy(() -> parser.parse("{\"refused\": false, \"mode\": \"magic\", \"anim\": {\"layers\": [], \"sounds\": []}, \"components\": []}"))
                .isInstanceOf(AiSchemaException.class)
                .satisfies(e -> assertThat(((AiSchemaException) e).errors()).extracting(AiError::message)
                        .anyMatch(m -> m.contains("mode")).anyMatch(m -> m.contains("至少")));
        assertThatThrownBy(() -> parser.parse("{\"refused\": false, \"mode\": \"compose\", \"anim\": {\"layers\": [{\"component\": \"#3\"}]}, \"components\": []}"))
                .isInstanceOf(AiSchemaException.class)
                .satisfies(e -> assertThat(((AiSchemaException) e).errors().get(0).message()).contains("layers[0]"));
    }

    @Test
    void 回饋文字_依階段排序_最多12則_帶位置() {
        String text = VibeFeedback.text(List.of(
                new AiError("smoke", 0, "畫太慢", 3, 5),
                new AiError("json", null, "回應不是 JSON 物件", null, null)));
        assertThat(text).startsWith("上一版有以下錯誤");
        assertThat(text.indexOf("[json]")).isLessThan(text.indexOf("[smoke]"));
        assertThat(text).contains("components[0] 畫太慢（第 3 行第 5 欄）");
    }
}
