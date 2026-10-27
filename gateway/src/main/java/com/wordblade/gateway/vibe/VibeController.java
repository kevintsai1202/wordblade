package com.wordblade.gateway.vibe;

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
 * Vibe特效（spec §5.7）：
 * <ul>
 *   <li>POST /v1/ai/vibe：開始（描述＋選填截圖＋長度／尺寸／目標框）→ 202 {jobId}</li>
 *   <li>GET /v1/ai/vibe/{jobId}：狀態與結果（running／done／failed）</li>
 *   <li>POST /v1/ai/vibe/{jobId}/feedback：桌面沙盒試跑的錯誤 → 202，續跑下一輪</li>
 * </ul>
 * 回應只有結構化欄位：拒答代碼，或 {mode, anim, components, target}；模型寫的自由文字不往下傳。
 */
@RestController
public class VibeController {

    /** 描述最多幾字 */
    static final int MAX_DESCRIPTION = 500;
    /** 截圖 data URL 最多幾字元（約 1.5 MB 的 JPEG） */
    static final int MAX_SCREENSHOT = 2_000_000;

    /** 桌面回饋的本體 */
    public record FeedbackBody(List<VibeError> errors) {}

    private final VibeJobs jobs;

    public VibeController(VibeJobs jobs) {
        this.jobs = jobs;
    }

    /** 開始一個 Vibe特效工作 */
    @PostMapping("/v1/ai/vibe")
    public ResponseEntity<Map<String, String>> start(@RequestBody VibeRequest body, HttpServletRequest req) {
        String problem = validate(body);
        if (problem != null) return ResponseEntity.badRequest().body(Map.of("error", problem));
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("jobId", jobs.start(token(req).id(), body)));
    }

    /** 工作狀態與結果 */
    @GetMapping("/v1/ai/vibe/{jobId}")
    public VibeJobs.View view(@PathVariable String jobId, HttpServletRequest req) {
        return jobs.view(token(req).id(), jobId);
    }

    /** 桌面沙盒試跑不過：送錯誤續跑 */
    @PostMapping("/v1/ai/vibe/{jobId}/feedback")
    public ResponseEntity<Void> feedback(@PathVariable String jobId, @RequestBody FeedbackBody body, HttpServletRequest req) {
        jobs.feedback(token(req).id(), jobId, body.errors() == null ? List.of() : body.errors());
        return ResponseEntity.status(HttpStatus.ACCEPTED).build();
    }

    @ExceptionHandler(VibeJobs.NotFoundException.class)
    ResponseEntity<Map<String, String>> notFound() {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "job-not-found"));
    }

    @ExceptionHandler(VibeJobs.TooManyRoundsException.class)
    ResponseEntity<Map<String, String>> tooMany() {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(Map.of("error", "no-more-rounds"));
    }

    /** 驗證攔截器放進 request 的身分 */
    private static TokenInfo token(HttpServletRequest req) {
        return (TokenInfo) req.getAttribute(TokenAuthInterceptor.ATTR);
    }

    /** 檢查請求；不合格回錯誤代碼 */
    static String validate(VibeRequest b) {
        if (b == null || b.description() == null || b.description().isBlank() || b.description().length() > MAX_DESCRIPTION) return "description";
        if (b.screenshot() != null && b.screenshot().length() > MAX_SCREENSHOT) return "screenshot";
        if (!(b.duration() > 0 && b.duration() <= 60) || b.fps() < 1 || b.fps() > 120 || b.width() < 100 || b.width() > 4000) return "size";
        VibeRequest.Box box = b.box();
        if (box == null || !(box.w() > 0 && box.h() > 0)) return "box";
        return null;
    }
}
