package com.wordblade.gateway;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.options;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.header;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.wordblade.gateway.auth.TokenService;
import com.wordblade.gateway.usage.UsageService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.web.servlet.MockMvc;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.postgresql.PostgreSQLContainer;

/** 整合測試：Testcontainers PostgreSQL（本機 Docker 不可用時自動略過）。 */
@SpringBootTest
@AutoConfigureMockMvc
@Testcontainers(disabledWithoutDocker = true)
class GatewayIntegrationTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer pg = new PostgreSQLContainer("postgres:17");

    @Autowired MockMvc mvc;
    @Autowired TokenService tokens;
    @Autowired UsageService usage;
    @Autowired JdbcClient jdbc;

    @Test
    void sha256符合已知向量() {
        assertThat(TokenService.sha256("abc"))
                .isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    }

    @Test
    void 沒帶權杖回401且帶CORS標頭() throws Exception {
        mvc.perform(get("/v1/me").header("Origin", "http://localhost:1420"))
                .andExpect(status().isUnauthorized())
                .andExpect(header().string("Access-Control-Allow-Origin", "http://localhost:1420"));
    }

    @Test
    void 錯誤權杖回401() throws Exception {
        mvc.perform(get("/v1/me").header("Authorization", "Bearer nope")).andExpect(status().isUnauthorized());
    }

    @Test
    void 資料表只存雜湊不存原文() {
        tokens.register("hash-check", "plain-secret-1");
        Long plain = jdbc.sql("SELECT COUNT(*) FROM invite_token WHERE token_sha256 = 'plain-secret-1'")
                .query(Long.class).single();
        assertThat(plain).isZero();
    }

    @Test
    void me回今日自己與全站用量() throws Exception {
        long a = tokens.register("alice", "tok-alice");
        long b = tokens.register("bob", "tok-bob");
        usage.record(a, "proofread", "muse-spark", 100, 20, 0);
        usage.record(a, "asr", null, 0, 0, 30);
        usage.record(b, "proofread", "muse-spark", 7, 3, 0);
        mvc.perform(get("/v1/me").header("Authorization", "Bearer tok-alice"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.name").value("alice"))
                .andExpect(jsonPath("$.self.calls").value(2))
                .andExpect(jsonPath("$.self.inputTokens").value(100))
                .andExpect(jsonPath("$.self.units").value(30))
                .andExpect(jsonPath("$.selfByRoute.length()").value(2))
                .andExpect(jsonPath("$.site.calls").value(org.hamcrest.Matchers.greaterThanOrEqualTo(3)));
    }

    @Test
    void 停用的權杖回401() throws Exception {
        long id = tokens.register("carol", "tok-carol");
        jdbc.sql("UPDATE invite_token SET disabled = TRUE WHERE id = :i").param("i", id).update();
        mvc.perform(get("/v1/me").header("Authorization", "Bearer tok-carol")).andExpect(status().isUnauthorized());
    }

    @Test
    void CORS預設放行清單() throws Exception {
        for (String o : new String[]{"http://localhost:1420", "http://tauri.localhost"}) {
            mvc.perform(options("/v1/me").header("Origin", o)
                            .header("Access-Control-Request-Method", "GET")
                            .header("Access-Control-Request-Headers", "authorization"))
                    .andExpect(status().isOk())
                    .andExpect(header().string("Access-Control-Allow-Origin", o));
        }
        mvc.perform(options("/v1/me").header("Origin", "http://evil.example")
                        .header("Access-Control-Request-Method", "GET"))
                .andExpect(status().isForbidden());
    }
}
