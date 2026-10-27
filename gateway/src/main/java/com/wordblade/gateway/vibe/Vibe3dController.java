package com.wordblade.gateway.vibe;

import com.wordblade.gateway.ai.AiError;
import com.wordblade.gateway.ai.AiJobs;
import com.wordblade.gateway.auth.TokenAuthInterceptor;
import com.wordblade.gateway.auth.TokenService.TokenInfo;
import jakarta.servlet.http.HttpServletRequest;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * Vibe特效 3D（spec §5.7）：POST /v1/ai/vibe3d 開始 → GET /v1/ai/vibe3d/{jobId} 輪詢 → POST …/feedback（3D 沙盒試跑的錯誤）。
 * 請求格式與 /v1/ai/vibe 相同；回應只有結構化欄位。
 */
@RestController
public class Vibe3dController {

    /** 桌面回饋的本體 */
    public record FeedbackBody(List<AiError> errors) {}

    private final Vibe3dJobs jobs;

    public Vibe3dController(Vibe3dJobs jobs) {
        this.jobs = jobs;
    }

    /** 開始 */
    @PostMapping("/v1/ai/vibe3d")
    public ResponseEntity<Map<String, String>> start(@RequestBody VibeRequest body, HttpServletRequest req) {
        String problem = VibeController.validate(body);
        if (problem != null) return ResponseEntity.badRequest().body(Map.of("error", problem));
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("jobId", jobs.start(token(req).id(), body)));
    }

    /** 狀態與結果 */
    @GetMapping("/v1/ai/vibe3d/{jobId}")
    public AiJobs.View<Vibe3dParser.Parsed> view(@PathVariable String jobId, HttpServletRequest req) {
        return jobs.view(token(req).id(), jobId);
    }

    /** 3D 沙盒試跑不過：送錯誤續跑 */
    @PostMapping("/v1/ai/vibe3d/{jobId}/feedback")
    public ResponseEntity<Void> feedback(@PathVariable String jobId, @RequestBody FeedbackBody body, HttpServletRequest req) {
        jobs.feedback(token(req).id(), jobId, body.errors() == null ? List.of() : body.errors());
        return ResponseEntity.status(HttpStatus.ACCEPTED).build();
    }

    @ExceptionHandler(AiJobs.NotFoundException.class)
    ResponseEntity<Map<String, String>> notFound() {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "job-not-found"));
    }

    @ExceptionHandler(AiJobs.TooManyRoundsException.class)
    ResponseEntity<Map<String, String>> tooMany() {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", "no-more-rounds"));
    }

    /** 驗證攔截器放進 request 的身分 */
    private static TokenInfo token(HttpServletRequest req) {
        return (TokenInfo) req.getAttribute(TokenAuthInterceptor.ATTR);
    }
}
