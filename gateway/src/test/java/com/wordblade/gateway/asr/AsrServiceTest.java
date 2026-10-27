package com.wordblade.gateway.asr;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

/** ASR 轉送：驗證 WAV、整理關鍵字、記用量（音訊秒數無條件進位）（假上游，不連網）。 */
class AsrServiceTest {

    /** 假上游：記下收到的東西，回固定結果 */
    static class FakeClient implements MuseAsrClient {
        byte[] wav;
        List<String> keywords;
        AsrResult reply = new AsrResult("hello world", List.of(new AsrResult.Turn("hello world", 100, 1900, "0")), 2500, List.of());

        @Override
        public AsrResult transcribe(byte[] wav, List<String> keywords) {
            this.wav = wav;
            this.keywords = keywords;
            return reply;
        }
    }

    final FakeClient client = new FakeClient();
    final List<String> usage = new ArrayList<>();
    final AsrService service = new AsrService(client, (token, model, units) -> usage.add(token + ":" + model + ":" + units), "muse-voice-transcribe-1.0");

    @Test
    void 轉送並記用量() {
        byte[] wav = WavInfoTest.wav(1, 16000, 16, 2.5);
        AsrResult r = service.transcribe(7, wav, List.of(" Spring AI ", "", "Tauri"));
        assertThat(r.turns()).hasSize(1);
        assertThat(client.wav).isSameAs(wav);
        assertThat(client.keywords).containsExactly("Spring AI", "Tauri");
        assertThat(usage).containsExactly("7:muse-voice-transcribe-1.0:3");
    }

    @Test
    void 關鍵字最多一百個且每個最多五十字() {
        List<String> many = new ArrayList<>();
        for (int i = 0; i < 150; i++) many.add("k" + i);
        many.set(0, "x".repeat(80));
        service.transcribe(1, WavInfoTest.wav(1, 16000, 16, 1), many);
        assertThat(client.keywords).hasSize(100);
        assertThat(client.keywords.get(0)).hasSize(50);
    }

    @Test
    void 格式不合不送上游也不記用量() {
        assertThatThrownBy(() -> service.transcribe(1, WavInfoTest.wav(2, 16000, 16, 1), List.of())).isInstanceOf(WavInfo.BadWavException.class);
        assertThat(client.wav).isNull();
        assertThat(usage).isEmpty();
    }
}
