package com.wordblade.gateway.synth;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** AI 音效與配樂的請求檢查（描述、長度、小節數、前一版 spec 的大小）。 */
class SynthControllerTest {

    private final JsonMapper json = JsonMapper.builder().build();

    @Test
    void 音效請求() {
        assertThat(SynthController.validate(new SoundRequest("whoosh", 0.7, null))).isNull();
        assertThat(SynthController.validate(new SoundRequest("", 0.7, null))).isEqualTo("description");
        assertThat(SynthController.validate(new SoundRequest(" ", 0.7, null))).isEqualTo("description");
        assertThat(SynthController.validate(new SoundRequest("x".repeat(301), 0.7, null))).isEqualTo("description");
        assertThat(SynthController.validate(new SoundRequest("whoosh", 0, null))).isEqualTo("length");
        assertThat(SynthController.validate(new SoundRequest("whoosh", 11, null))).isEqualTo("length");
        assertThat(SynthController.validate((SoundRequest) null)).isEqualTo("description");
    }

    @Test
    void 配樂請求() {
        assertThat(SynthController.validate(new MusicRequest("calm lo-fi", 8, null))).isNull();
        assertThat(SynthController.validate(new MusicRequest("calm lo-fi", 0, null))).isEqualTo("bars");
        assertThat(SynthController.validate(new MusicRequest("calm lo-fi", 33, null))).isEqualTo("bars");
        assertThat(SynthController.validate(new MusicRequest(null, 8, null))).isEqualTo("description");
    }

    @Test
    void 前一版spec要是物件且不能太大() {
        assertThat(SynthController.validate(new MusicRequest("slower", 8, json.readTree("{\"bpm\":100}")))).isNull();
        assertThat(SynthController.validate(new MusicRequest("slower", 8, json.readTree("[1,2]")))).isEqualTo("previous");
        String big = "{\"x\":\"" + "a".repeat(SynthController.MAX_PREVIOUS) + "\"}";
        assertThat(SynthController.validate(new MusicRequest("slower", 8, json.readTree(big)))).isEqualTo("previous");
    }
}
