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

    @Test
    void 送出DIARIZATION並解析turns() {
        server.expect(requestTo("https://api.example/v1/asr/transcribe"))
                .andExpect(method(HttpMethod.POST))
                .andExpect(header("Authorization", "Bearer k"))
                .andExpect(content().string(allOf(
                        containsString("name=\"request\""),
                        containsString("\"mode\":\"DIARIZATION\""),
                        containsString("\"model\":\"muse-voice-transcribe-1.0\""),
                        containsString("\"keywords\":[\"Tauri\"]"),
                        containsString("name=\"audio\""),
                        // Meta 不收 part 自帶 Content-Length 的 multipart（回 400 Malformed multipart body）
                        not(containsString("Content-Length")))))
                .andRespond(withSuccess("""
                        {"transcript":"Hello there. Again.","audioDurationMs":4000,"extra":"x",
                         "turns":[{"transcript":"Hello there.","startMs":150,"endMs":1800,"speaker":"0"},
                                  {"transcript":"Again.","startMs":2500,"endMs":3200}]}""", MediaType.APPLICATION_JSON));
        AsrResult r = client.transcribe(WavInfoTest.wav(1, 16000, 16, 4), List.of("Tauri"));
        assertThat(r.transcript()).isEqualTo("Hello there. Again.");
        assertThat(r.audioDurationMs()).isEqualTo(4000);
        assertThat(r.turns()).containsExactly(new AsrResult.Turn("Hello there.", 150, 1800, "0"), new AsrResult.Turn("Again.", 2500, 3200, null));
        server.verify();
    }

    @Test
    void 沒有關鍵字就不送keywords() {
        server.expect(requestTo("https://api.example/v1/asr/transcribe"))
                .andExpect(content().string(not(containsString("keywords"))))
                .andRespond(withSuccess("{\"transcript\":\"\",\"turns\":[]}", MediaType.APPLICATION_JSON));
        assertThat(client.transcribe(WavInfoTest.wav(1, 16000, 16, 1), List.of()).turns()).isEmpty();
    }

    @Test
    void 上游錯誤轉成AsrUpstreamException() {
        server.expect(requestTo("https://api.example/v1/asr/transcribe")).andRespond(withStatus(HttpStatus.TOO_MANY_REQUESTS));
        assertThatThrownBy(() -> client.transcribe(WavInfoTest.wav(1, 16000, 16, 1), List.of()))
                .isInstanceOfSatisfying(AsrUpstreamException.class, e -> assertThat(e.status()).isEqualTo(429));
    }
}
