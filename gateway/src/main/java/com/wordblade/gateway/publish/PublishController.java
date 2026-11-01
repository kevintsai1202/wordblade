package com.wordblade.gateway.publish;

import com.wordblade.gateway.auth.TokenAuthInterceptor;
import com.wordblade.gateway.auth.TokenService.TokenInfo;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartFile;

/**
 * 發佈包（spec §5.17、§5.12）：
 * - POST /v1/ai/publish（JSON {language, duration, lines:[{t, text}]}）→ 202 {jobId}；GET /v1/ai/publish/{jobId} → {status, kit, error}
 * - POST /v1/ai/image（multipart：purpose＝thumbnail（附 image＝PNG／JPEG）、texture、background（只要 prompt 描述，§5.12））→ 202 {jobId}；GET /v1/ai/image/{jobId} → {status, image（base64）, mime, error}
 */
@RestController
public class PublishController {

    /** 發佈包請求 */
    public record PublishRequest(String language, double duration, List<PublishJobs.Line> lines) {}

    private final PublishJobs jobs;

    public PublishController(PublishJobs jobs) {
        this.jobs = jobs;
    }

    /** 開始寫發佈包 */
    @PostMapping(path = "/v1/ai/publish", consumes = MediaType.APPLICATION_JSON_VALUE)
    public ResponseEntity<Map<String, String>> startKit(@RequestBody PublishRequest body, HttpServletRequest req) {
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("jobId", jobs.startKit(token(req).id(), body.language(), body.duration(), body.lines())));
    }

    @GetMapping("/v1/ai/publish/{jobId}")
    public PublishJobs.KitView viewKit(@PathVariable String jobId, HttpServletRequest req) {
        return jobs.viewKit(token(req).id(), jobId);
    }

    /** 開始改縮圖底圖 */
    @PostMapping(path = "/v1/ai/image", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<Map<String, String>> startImage(@RequestPart("purpose") String purpose, @RequestPart(name = "prompt", required = false) String prompt,
                                                          @RequestPart(name = "image", required = false) MultipartFile image, HttpServletRequest req) throws IOException {
        if (image != null && image.getSize() > PublishJobs.MAX_IMAGE_BYTES) throw new IllegalArgumentException("image too large");
        // 材質、3D 背景不附圖（產生新圖）；縮圖要附圖（PublishJobs 檢查）
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("jobId", jobs.startImage(token(req).id(), purpose, prompt,
                image == null ? null : image.getBytes(), image == null ? null : image.getContentType())));
    }

    @GetMapping("/v1/ai/image/{jobId}")
    public PublishJobs.ImageView viewImage(@PathVariable String jobId, HttpServletRequest req) {
        return jobs.viewImage(token(req).id(), jobId);
    }

    @ExceptionHandler(PublishJobs.NotFoundException.class)
    ResponseEntity<Map<String, String>> notFound() {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not-found"));
    }

    @ExceptionHandler({IllegalArgumentException.class, tools.jackson.core.JacksonException.class})
    ResponseEntity<Map<String, String>> bad() {
        return ResponseEntity.badRequest().body(Map.of("error", "bad-request"));
    }

    @ExceptionHandler(java.util.concurrent.RejectedExecutionException.class)
    ResponseEntity<Map<String, String>> busy() {
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS).header("Retry-After", "10").body(Map.of("error", "publish-busy"));
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    ResponseEntity<Map<String, String>> tooLarge() {
        return ResponseEntity.status(HttpStatus.CONTENT_TOO_LARGE).body(Map.of("error", "image-too-large"));
    }

    private static TokenInfo token(HttpServletRequest req) {
        return (TokenInfo) req.getAttribute(TokenAuthInterceptor.ATTR);
    }
}
