package com.wordblade.gateway.plane3d;

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
 * 「用說的」（spec §5.8）：POST /v1/ai/plane3d 開始 → GET /v1/ai/plane3d/{jobId} 輪詢 → POST …/feedback（桌面檢查姿勢路徑不過時）。
 * 回應只有結構化欄位：拒答代碼，或板子設定的提議。
 */
@RestController
public class Plane3dController {

    /** 描述最多幾字 */
    static final int MAX_DESCRIPTION = 300;
    /** 截圖 data URL 最多幾字元 */
    static final int MAX_SCREENSHOT = 2_000_000;

    /** 桌面回饋的本體 */
    public record FeedbackBody(List<AiError> errors) {}

    private final Plane3dJobs jobs;

    public Plane3dController(Plane3dJobs jobs) {
        this.jobs = jobs;
    }

    /** 開始 */
    @PostMapping("/v1/ai/plane3d")
    public ResponseEntity<Map<String, String>> start(@RequestBody Plane3dRequest body, HttpServletRequest req) {
        String problem = validate(body);
        if (problem != null) return ResponseEntity.badRequest().body(Map.of("error", problem));
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("jobId", jobs.start(token(req).id(), body)));
    }

    /** 狀態與提議 */
    @GetMapping("/v1/ai/plane3d/{jobId}")
    public AiJobs.View<Plane3dParser.Result> view(@PathVariable String jobId, HttpServletRequest req) {
        return jobs.view(token(req).id(), jobId);
    }

    /** 桌面檢查不過：送錯誤續跑 */
    @PostMapping("/v1/ai/plane3d/{jobId}/feedback")
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

    /** 檢查請求；不合格回錯誤代碼 */
    static String validate(Plane3dRequest b) {
        if (b == null || b.description() == null || b.description().isBlank() || b.description().length() > MAX_DESCRIPTION) return "description";
        if (b.screenshot() != null && b.screenshot().length() > MAX_SCREENSHOT) return "screenshot";
        if (!(b.length() > 0 && b.length() <= 600) || b.width() < 16 || b.height() < 16 || b.width() > 8000 || b.height() > 8000) return "size";
        return null;
    }
}
