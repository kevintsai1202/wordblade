package com.wordblade.gateway.vibe;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.wordblade.gateway.ai.AiError;
import com.wordblade.gateway.ai.AiSchemaException;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** Vibe特效 3D 回應的解析：拒答、只填內建元件參數、新插件（程式在桌面 3D 沙盒試跑，這裡只檢查形狀）。 */
class Vibe3dParserTest {

    private final Vibe3dParser parser = new Vibe3dParser(JsonMapper.builder().build());

    /** 斷言被擋下，且某則錯誤訊息包含 hint */
    private void rejects(String json, String hint) {
        assertThatThrownBy(() -> parser.parse(json))
                .isInstanceOf(AiSchemaException.class)
                .satisfies(e -> assertThat(((AiSchemaException) e).errors()).extracting(AiError::message).anyMatch(m -> m.contains(hint)));
    }

    @Test
    void 拒答() {
        assertThat(parser.parse("{\"refused\": true, \"code\": \"unsafe\"}").refusal()).isEqualTo("unsafe");
        assertThat(parser.parse("{\"refused\": true, \"code\": \"whatever\"}").refusal()).isEqualTo("off-topic");
    }

    @Test
    void 只填內建元件參數() {
        Vibe3dParser.Parsed p = parser.parse("{\"refused\": false, \"mode\": \"params\", \"title\": \"Wave\", \"component\": \"mascot\", \"params\": {\"action\": \"wave\"}}");
        assertThat(p.mode()).isEqualTo("params");
        assertThat(p.builtin()).isEqualTo("mascot");
        assertThat(p.params().get("action").asString()).isEqualTo("wave");
        rejects("{\"refused\": false, \"mode\": \"params\", \"component\": \"robot\", \"params\": {}}", "內建元件");
    }

    @Test
    void 新插件_程式碼陣列接成字串_只留已知欄位() {
        Vibe3dParser.Parsed p = parser.parse("""
                {"refused": false, "mode": "new", "title": "Coin", "note": "hi",
                 "component": {"name": "Coin", "description": "A coin", "params": {"color": {"type": "color", "default": "#ffcc33", "label": "Color"}},
                               "code": ["function setup(THREE, scene, camera, env) {}", "function update(t, env) {}"], "extra": 1}}""");
        assertThat(p.mode()).isEqualTo("new");
        assertThat(p.component().get("code").asString()).isEqualTo("function setup(THREE, scene, camera, env) {}\nfunction update(t, env) {}");
        assertThat(p.component().has("extra")).isFalse();
        assertThat(p.title()).isEqualTo("Coin");
    }

    @Test
    void 新插件的形狀檢查() {
        rejects("{\"refused\": false, \"mode\": \"new\", \"component\": {\"name\": \"x\", \"params\": {}, \"code\": []}}", "code");
        rejects("{\"refused\": false, \"mode\": \"new\", \"component\": {\"name\": \"x\", \"params\": {\"a\": {\"type\": \"point\", \"default\": 1}}, \"code\": [\"x\"]}}", "型別");
        rejects("{\"refused\": false, \"mode\": \"magic\"}", "mode");
        rejects("not json", "JSON");
    }
}
