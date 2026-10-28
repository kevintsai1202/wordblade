package com.wordblade.gateway.sam;

import com.wordblade.gateway.auth.TokenAuthInterceptor;
import com.wordblade.gateway.auth.TokenService.TokenInfo;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartFile;

/**
 * SAM 3.1 遮罩（spec §5.3）：
 * - POST /v1/sam（multipart：prompt＝英文名詞片語、clip＝縮小無聲的 MP4）→ 202 {jobId}
 * - GET /v1/sam/{jobId}?after=N → 狀態與游標之後的逐格輸出（一格一行，桌面解析）
 * - DELETE /v1/sam/{jobId} → 取消（中止上游、刪檔）
 * - POST /v1/ai/mask-phrase {text} → {phrase}：任何語言 → SAM 看得懂的英文名詞片語（已經合格就不呼叫模型；不是畫面上看得到的東西回空字串）
 */
@RestController
public class SamController {

    /** 要翻譯的文字最多幾字 */
    static final int MAX_TEXT = 200;

    /** 翻譯的請求 */
    public record PhraseBody(String text) {}

    private final SamJobs jobs;
    private final SamPhraseTranslator translator;

    public SamController(SamJobs jobs, SamPhraseTranslator translator) {
        this.jobs = jobs;
        this.translator = translator;
    }

    /** 開始 */
    @PostMapping(path = "/v1/sam", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<Map<String, String>> start(@RequestPart("prompt") String prompt, @RequestPart("clip") MultipartFile clip, HttpServletRequest req) throws IOException {
        if (!SamPhrase.valid(prompt)) return ResponseEntity.badRequest().body(Map.of("error", "bad-prompt"));
        if (clip.isEmpty()) return ResponseEntity.badRequest().body(Map.of("error", "empty-clip"));
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("jobId", jobs.start(token(req).id(), prompt.trim(), clip.getBytes())));
    }

    /** 狀態與新的逐格輸出 */
    @GetMapping("/v1/sam/{jobId}")
    public SamJobs.View view(@PathVariable String jobId, @RequestParam(defaultValue = "0") int after, HttpServletRequest req) {
        return jobs.view(token(req).id(), jobId, after);
    }

    /** 取消 */
    @DeleteMapping("/v1/sam/{jobId}")
    public ResponseEntity<Void> cancel(@PathVariable String jobId, HttpServletRequest req) {
        jobs.cancel(token(req).id(), jobId);
        return ResponseEntity.status(HttpStatus.ACCEPTED).build();
    }

    /** 翻成英文名詞片語 */
    @PostMapping("/v1/ai/mask-phrase")
    public ResponseEntity<Map<String, String>> phrase(@RequestBody PhraseBody body, HttpServletRequest req) {
        String text = body == null || body.text() == null ? "" : body.text().strip();
        if (text.isEmpty() || text.length() > MAX_TEXT) return ResponseEntity.badRequest().body(Map.of("error", "bad-text"));
        if (SamPhrase.valid(text)) return ResponseEntity.ok(Map.of("phrase", text));
        String phrase = translator.translate(token(req).id(), text);
        return ResponseEntity.ok(Map.of("phrase", SamPhrase.valid(phrase) ? phrase : ""));
    }

    @ExceptionHandler(SamJobs.NotFoundException.class)
    ResponseEntity<Map<String, String>> notFound() {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not-found"));
    }

    @ExceptionHandler(SamJobs.BusyException.class)
    ResponseEntity<Map<String, String>> busy() {
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS).header("Retry-After", "5").body(Map.of("error", "sam-busy"));
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    ResponseEntity<Map<String, String>> tooLarge() {
        return ResponseEntity.status(HttpStatus.CONTENT_TOO_LARGE).body(Map.of("error", "clip-too-large"));
    }

    private static TokenInfo token(HttpServletRequest req) {
        return (TokenInfo) req.getAttribute(TokenAuthInterceptor.ATTR);
    }
}
