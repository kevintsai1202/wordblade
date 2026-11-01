package com.wordblade.gateway.asr;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.hamcrest.Matchers.allOf;
import static org.hamcrest.Matchers.containsString;
import static org.hamcrest.Matchers.not;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.content;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

/** 呼叫 Meta 的 /v1/asr/transcribe：multipart 的 request（JSON）與 audio（WAV）、解析回應、上游錯誤。 */
class RestMuseAsrClientTest {

    final RestClient.Builder builder = RestClient.builder().baseUrl("https://api.example").defaultHeader("Authorization", "Bearer k");
    final MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
    final RestMuseAsrClient client = new RestMuseAsrClient(builder.build(), "muse-voice-transcribe-1.0", JsonMapper.builder().build());

    /** 一段 DELTA 串流（Meta 的 SSE 格式：data: 一行一個 JSON 事件） */
    static String sse(String... events) {
        StringBuilder b = new StringBuilder();
        for (String e : events) b.append("data: ").append(e).append("\n\n");
        return b.toString();
    }

    static final String STREAM = sse(
            "{\"type\":\"speechStart\",\"audioProcessedMs\":940,\"turnId\":0}",
            "{\"type\":\"transcript\",\"transcript\":\" Hello\",\"final\":false,\"audioProcessedMs\":1440}",
            "{\"type\":\"audioProgress\",\"audioProcessedMs\":1500}",
            "{\"type\":\"transcript\",\"transcript\":\" there.\",\"final\":false,\"audioProcessedMs\":1840}",
            "{\"type\":\"transcript\",\"transcript\":\"\",\"final\":false,\"audioProcessedMs\":1900}",
            "{\"type\":\"speaker\",\"label\":\"A\",\"audioProcessedMs\":1900}",
            "{\"type\":\"speechEnd\",\"audioProcessedMs\":2100,\"turnId\":0}",
            "{\"type\":\"speechComplete\",\"audioProcessedMs\":2100,\"turnId\":0,\"transcript\":\" Hello there.\"}",
            "{\"type\":\"speechStart\",\"audioProcessedMs\":2600,\"turnId\":1}",
            "{\"type\":\"transcript\",\"transcript\":\" Again.\",\"final\":false,\"audioProcessedMs\":3200}",
            "{\"type\":\"speechEnd\",\"audioProcessedMs\":3400,\"turnId\":1}",
            "{\"type\":\"speechComplete\",\"audioProcessedMs\":3400,\"turnId\":1,\"transcript\":\" Again.\"}",
            "{\"type\":\"transcript\",\"transcript\":\"\",\"final\":true,\"audioProcessedMs\":4000}");

    @Test
    void 送出DELTA串流並解析turns與deltas() {
        server.expect(requestTo("https://api.example/v1/asr/transcribe"))
                .andExpect(method(HttpMethod.POST))
                .andExpect(header("Authorization", "Bearer k"))
                .andExpect(header("Accept", "text/event-stream"))
                .andExpect(content().string(allOf(
                        containsString("name=\"request\""),
                        containsString("\"mode\":\"DIARIZATION\""),
                        containsString("\"partialMode\":\"DELTA\""),
                        containsString("\"model\":\"muse-voice-transcribe-1.0\""),
                        containsString("\"keywords\":[\"Tauri\"]"),
                        containsString("name=\"audio\""),
                        // Meta 不收 part 自帶 Content-Length 的 multipart（回 400 Malformed multipart body）
                        not(containsString("Content-Length")))))
                .andRespond(withSuccess(STREAM, MediaType.TEXT_EVENT_STREAM));
        AsrResult r = client.transcribe(WavInfoTest.wav(1, 16000, 16, 4), List.of("Tauri"));
        assertThat(r.transcript()).isEqualTo("Hello there. Again.");
        assertThat(r.audioDurationMs()).isEqualTo(4000);
        // turn 的時間是事件的 audioProcessedMs（比實際晚，桌面會扣掉延遲）
        assertThat(r.turns()).containsExactly(new AsrResult.Turn("Hello there.", 940, 2100, "A"), new AsrResult.Turn("Again.", 2600, 3400, null));
        // 空的與 final 事件略過；文字去掉前後空白
        assertThat(r.deltas()).containsExactly(new AsrResult.Delta("Hello", 1440), new AsrResult.Delta("there.", 1840), new AsrResult.Delta("Again.", 3200));
        server.verify();
    }

    @Test
    void 中文串流以UTF8解讀_上游沒標charset也不會變亂碼() {
        // Meta 回 text/event-stream 不帶 charset；當成 ISO-8859-1 讀會把中文變成「æä»¬」（2026-10-31 實測 OBS 錄影）
        String stream = sse("{\"type\":\"speechStart\",\"audioProcessedMs\":100,\"turnId\":0}",
                "{\"type\":\"transcript\",\"transcript\":\"我们 接下来\",\"final\":false,\"audioProcessedMs\":500}",
                "{\"type\":\"speechComplete\",\"audioProcessedMs\":900,\"turnId\":0,\"transcript\":\"我们 接下来\"}");
        server.expect(requestTo("https://api.example/v1/asr/transcribe"))
                .andRespond(withSuccess(stream.getBytes(java.nio.charset.StandardCharsets.UTF_8), MediaType.TEXT_EVENT_STREAM));
        AsrResult r = client.transcribe(WavInfoTest.wav(1, 16000, 16, 1), List.of());
        assertThat(r.deltas()).containsExactly(new AsrResult.Delta("我们 接下来", 500));
        assertThat(r.turns().get(0).transcript()).isEqualTo("我们 接下来");
    }

    @Test
    void 沒有關鍵字就不送keywords() {
        server.expect(requestTo("https://api.example/v1/asr/transcribe"))
                .andExpect(content().string(not(containsString("keywords"))))
                .andRespond(withSuccess(sse("{\"type\":\"transcript\",\"transcript\":\"\",\"final\":true,\"audioProcessedMs\":1000}"), MediaType.TEXT_EVENT_STREAM));
        AsrResult r = client.transcribe(WavInfoTest.wav(1, 16000, 16, 1), List.of());
        assertThat(r.turns()).isEmpty();
        assertThat(r.deltas()).isEmpty();
    }

    @Test
    void 串流中的錯誤事件轉成AsrUpstreamException() {
        server.expect(requestTo("https://api.example/v1/asr/transcribe"))
                .andRespond(withSuccess(sse("{\"type\":\"error\",\"message\":\"boom\",\"sessionId\":\"x\"}"), MediaType.TEXT_EVENT_STREAM));
        assertThatThrownBy(() -> client.transcribe(WavInfoTest.wav(1, 16000, 16, 1), List.of()))
                .isInstanceOfSatisfying(AsrUpstreamException.class, e -> assertThat(e.status()).isEqualTo(0));
    }

    @Test
    void 上游錯誤轉成AsrUpstreamException() {
        server.expect(requestTo("https://api.example/v1/asr/transcribe")).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS));
        assertThatThrownBy(() -> client.transcribe(WavInfoTest.wav(1, 16000, 16, 1), List.of()))
                .isInstanceOfSatisfying(AsrUpstreamException.class, e -> assertThat(e.status()).isEqualTo(429));
    }
}
