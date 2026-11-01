package com.wordblade.gateway.tts;

import com.wordblade.gateway.auth.TokenAuthInterceptor;
import com.wordblade.gateway.auth.TokenService.TokenInfo;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * AI 重生語音（spec §5.6）：
 * - POST /v1/tts（JSON：text、seed＝樣本 WAV base64、seedText＝樣本裡講的文字、speed）→ 202 {jobId}
 * - GET /v1/tts/{jobId} → {status, audio（標準 WAV base64）, seconds, error}
 */
@RestController
public class TtsController {

    private final TtsJobs jobs;

    public TtsController(TtsJobs jobs) {
        this.jobs = jobs;
    }

    @PostMapping(path = "/v1/tts", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, String>> start(@RequestBody TtsJobs.Request body, HttpServletRequest req) {
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("jobId", jobs.start(token(req).id(), body)));
    }

    @GetMapping("/v1/tts/{jobId}")
    public TtsJobs.View view(@PathVariable String jobId, HttpServletRequest req) {
        return jobs.view(token(req).id(), jobId);
    }

    @ExceptionHandler(TtsJobs.NotFoundException.class)
    ResponseEntity<Map<String, String>> notFound() {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not-found"));
    }

    @ExceptionHandler({IllegalArgumentException.class, tools.jackson.core.JacksonException.class})
    ResponseEntity<Map<String, String>> bad() {
        return ResponseEntity.badRequest().body(Map.of("error", "bad-request"));
    }

    @ExceptionHandler(java.util.concurrent.RejectedExecutionException.class)
    ResponseEntity<Map<String, String>> busy() {
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS).body(Map.of("error", "busy"));
    }

    private static TokenInfo token(HttpServletRequest req) {
        return (TokenInfo) req.getAttribute(TokenAuthInterceptor.ATTR);
    }
}
