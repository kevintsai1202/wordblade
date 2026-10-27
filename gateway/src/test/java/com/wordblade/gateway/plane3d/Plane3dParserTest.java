package com.wordblade.gateway.plane3d;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.wordblade.gateway.ai.AiError;
import com.wordblade.gateway.ai.AiSchemaException;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** 「用說的」回應的解析與驗證（移植原專案 plane3d_ai.parse_response＋validate_plane3d 的範圍與時間檢查；姿勢路徑由桌面檢查）。 */
class Plane3dParserTest {

    private final Plane3dParser parser = Plane3dParser.fromResources(JsonMapper.builder().build());

    /** 解析，區段 6 秒、目前 edges 開 */
    private Plane3dParser.Result parse(String json) {
        return parser.parse(json, 6.0, true);
    }

    /** 斷言回應被擋下，且某則錯誤訊息包含 hint */
    private void rejects(String json, String hint) {
        assertThatThrownBy(() -> parse(json))
                .isInstanceOf(AiSchemaException.class)
                .satisfies(e -> assertThat(((AiSchemaException) e).errors()).extracting(AiError::message).anyMatch(m -> m.contains(hint)));
    }

    @Test
    void 拒答只收兩種代碼() {
        assertThat(parse("{\"refused\":\"off-topic\"}").refusal()).isEqualTo("off-topic");
        assertThat(parse("{\"refused\":\"too-complex\"}").refusal()).isEqualTo("too-complex");
        rejects("{\"refused\":\"unsafe\"}", "refused");
    }

    @Test
    void 關鍵幀補預設值_丟掉多餘欄位與模型的文字() {
        Plane3dParser.Result r = parse("""
                ```json
                {"keys":[{"t":0,"ry":55,"size":0.55,"px":0.12},{"anchor":"start","t":1.5,"size":0.82,"ease":"out","note":"x"}],
                 "explanation":"I turned it","background":"grid"}
                ```""");
        assertThat(r.refusal()).isNull();
        var keys = r.proposal().get("keys");
        assertThat(keys.size()).isEqualTo(2);
        assertThat(keys.get(0).get("anchor").asString()).isEqualTo("start");
        assertThat(keys.get(0).get("rx").asDouble()).isZero();
        assertThat(keys.get(0).get("ease").asString()).isEqualTo("inOut");
        assertThat(keys.get(1).has("note")).isFalse();
        assertThat(r.proposal().get("background").asString()).isEqualTo("grid");
        assertThat(r.proposal().has("explanation")).isFalse();
    }

    @Test
    void 範圍與欄位檢查() {
        rejects("{\"keys\":[{\"t\":0,\"rx\":95}]}", "rx");
        rejects("{\"keys\":[{\"t\":0,\"size\":3}]}", "size");
        rejects("{\"keys\":[]}", "keys");
        rejects("{\"keys\":[{\"t\":0}],\"float\":{\"rx\":30,\"ry\":3,\"period\":4}}", "float");
        rejects("{\"keys\":[{\"t\":0}],\"background\":\"desk\"}", "background");
        rejects("{\"keys\":[{\"t\":0}],\"background\":\"color\",\"color\":\"red\"}", "color");
    }

    @Test
    void 時間不能超過區段長度_換算後要嚴格遞增() {
        rejects("{\"keys\":[{\"t\":7}]}", "超過區段長度");
        rejects("{\"keys\":[{\"t\":2},{\"t\":1}]}", "遞增");
        // 錨定結尾的點排在開頭的點後面：OK
        assertThat(parse("{\"keys\":[{\"t\":0},{\"anchor\":\"end\",\"t\":0}]}").proposal().get("keys").size()).isEqualTo(2);
    }
}
