package com.wordblade.gateway.director;

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
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartFile;
import tools.jackson.databind.json.JsonMapper;

/**
 * AI 導演（spec §5.11）：
 * - POST /v1/ai/director {mediaName, duration, segments, scenes:[{id,name}]} → 202 {jobId}
 * - POST /v1/ai/director/{jobId}/segments/{index}（multipart：video＝480p 每秒 2 格無聲 MP4、meta＝{start, end, words:[{id,t,text}]}）→ 202
 * - GET /v1/ai/director/{jobId} → 狀態、段落進度、建議
 * - DELETE /v1/ai/director/{jobId} → 取消
 */
@RestController
public class DirectorController {

    /** 一段影片最大幾位元組（2 分鐘 250 kbps 約 4 MB，留餘裕） */
    static final long MAX_SEGMENT_BYTES = 20L * 1024 * 1024;

    private final DirectorJobs jobs;
    private final JsonMapper json = JsonMapper.builder().build();

    public DirectorController(DirectorJobs jobs) {
        this.jobs = jobs;
    }

    /** 建工作 */
    @PostMapping("/v1/ai/director")
    public ResponseEntity<Map<String, String>> start(@RequestBody DirectorJobs.StartRequest body, HttpServletRequest req) {
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("jobId", jobs.start(token(req).id(), body)));
    }

    /** 上傳一段 */
    @PostMapping(path = "/v1/ai/director/{jobId}/segments/{index}", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<Void> segment(@PathVariable String jobId, @PathVariable int index, @RequestPart("video") MultipartFile video,
                                        @RequestPart("meta") String meta, HttpServletRequest req) throws IOException {
        if (video.isEmpty() || video.getSize() > MAX_SEGMENT_BYTES) throw new IllegalArgumentException("bad video");
        DirectorJobs.SegmentMeta m = json.readValue(meta, DirectorJobs.SegmentMeta.class);
        jobs.addSegment(token(req).id(), jobId, index, m, video.getBytes());
        return ResponseEntity.status(HttpStatus.ACCEPTED).build();
    }

    /** 狀態與建議 */
    @GetMapping("/v1/ai/director/{jobId}")
    public DirectorJobs.View view(@PathVariable String jobId, HttpServletRequest req) {
        return jobs.view(token(req).id(), jobId);
    }

    /** 取消 */
    @DeleteMapping("/v1/ai/director/{jobId}")
    public ResponseEntity<Void> cancel(@PathVariable String jobId, HttpServletRequest req) {
        jobs.cancel(token(req).id(), jobId);
        return ResponseEntity.status(HttpStatus.ACCEPTED).build();
    }

    @ExceptionHandler(DirectorJobs.NotFoundException.class)
    ResponseEntity<Map<String, String>> notFound() {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not-found"));
    }

    @ExceptionHandler({IllegalArgumentException.class, tools.jackson.core.JacksonException.class})
    ResponseEntity<Map<String, String>> bad() {
        return ResponseEntity.badRequest().body(Map.of("error", "bad-request"));
    }

    @ExceptionHandler(java.util.concurrent.RejectedExecutionException.class)
    ResponseEntity<Map<String, String>> busy() {
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS).header("Retry-After", "10").body(Map.of("error", "director-busy"));
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    ResponseEntity<Map<String, String>> tooLarge() {
        return ResponseEntity.status(HttpStatus.CONTENT_TOO_LARGE).body(Map.of("error", "segment-too-large"));
    }

    private static TokenInfo token(HttpServletRequest req) {
        return (TokenInfo) req.getAttribute(TokenAuthInterceptor.ATTR);
    }
}
