package com.wordblade.gateway.director;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.hamcrest.Matchers.allOf;
import static org.hamcrest.Matchers.containsString;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.content;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.header;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.json.JsonMapper;

/** Jev 判斷重講候選（TypeSafe /v1/systemone）：兩題 Noul、中文以 UTF-8 送出與解讀、上游錯誤丟例外。 */
class RestJevRetakeJudgeTest {

    final RestClient.Builder builder = RestClient.builder().baseUrl("https://api.typesafe.example").defaultHeader("Authorization", "Bearer t");
    final MockRestServiceServer server = MockRestServiceServer.bindTo(builder).build();
    final RestJevRetakeJudge judge = new RestJevRetakeJudge(builder.build(), "jev-latest", JsonMapper.builder().build());

    @Test
    void 送兩題_Noul_回重講與講完整的機率() {
        server.expect(requestTo("https://api.typesafe.example/v1/systemone"))
                .andExpect(method(HttpMethod.POST))
                .andExpect(header("Authorization", "Bearer t"))
                .andExpect(content().string(allOf(containsString("\"model\":\"jev-latest\""), containsString("\"type\":\"noul\""),
                        containsString("好我們接下來"), containsString("\"retake\""), containsString("\"complete\""))))
                .andRespond(withSuccess("""
                        {"model":"jev-1.14.0","answers":{"retake":{"type":"noul","noul":0.71},"complete":{"type":"noul","noul":0.93}},
                         "usage":{"input_tokens":476,"output_tokens":2}}""".getBytes(java.nio.charset.StandardCharsets.UTF_8), MediaType.APPLICATION_JSON));
        DirectorJobs.RetakeVerdict v = judge.judge("好我們接下來這個章節", "我們接下來這個章節主要介紹");
        assertThat(v).isEqualTo(new DirectorJobs.RetakeVerdict(0.71, 0.93, 476, "jev-1.14.0"));
        server.verify();
    }

    @Test
    void 上游錯誤或缺答案丟例外() {
        server.expect(requestTo("https://api.typesafe.example/v1/systemone")).andRespond(withStatus(HttpStatus.UNAUTHORIZED));
        assertThatThrownBy(() -> judge.judge("a", "b")).isInstanceOf(RuntimeException.class);
        server.reset();
        server.expect(requestTo("https://api.typesafe.example/v1/systemone")).andRespond(withSuccess("{\"answers\":{}}", MediaType.APPLICATION_JSON));
        assertThatThrownBy(() -> judge.judge("a", "b")).isInstanceOf(IllegalStateException.class);
    }
}
