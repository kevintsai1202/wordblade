package com.wordblade.gateway.locate;

import com.wordblade.gateway.auth.TokenAuthInterceptor;
import com.wordblade.gateway.auth.TokenService.TokenInfo;
import jakarta.servlet.http.HttpServletRequest;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartFile;
import tools.jackson.databind.json.JsonMapper;

/**
 * 螢幕文字定位（spec §5.3）：
 * - POST /v1/ai/locate（multipart：target＝要找的東西、times＝各張的素材時間 JSON 陣列、frame＝JPEG，可重複，順序同 times）→ 202 {jobId}
 * - GET /v1/ai/locate/{jobId} → {status, frames:[{t, items:[{text,x,y,w,h}]}], error}
 */
@RestController
public class LocateController {

    /** 一張畫面最大幾位元組 */
    static final long MAX_FRAME_BYTES = 2L * 1024 * 1024;

    private final LocateJobs jobs;
    private final JsonMapper json = JsonMapper.builder().build();

    public LocateController(LocateJobs jobs) {
        this.jobs = jobs;
    }

    /** 開始 */
    @PostMapping(path = "/v1/ai/locate", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public ResponseEntity<Map<String, String>> start(@RequestPart("target") String target, @RequestPart("times") String times,
                                                     @RequestPart("frame") List<MultipartFile> frames, HttpServletRequest req) throws IOException {
        double[] ts = json.readValue(times, double[].class);
        if (ts.length != frames.size()) throw new IllegalArgumentException("times and frames differ");
        List<LocateJobs.Frame> list = new ArrayList<>();
        for (int i = 0; i < ts.length; i++) {
            MultipartFile f = frames.get(i);
            if (f.isEmpty() || f.getSize() > MAX_FRAME_BYTES) throw new IllegalArgumentException("bad frame");
            list.add(new LocateJobs.Frame(ts[i], f.getBytes()));
        }
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("jobId", jobs.start(token(req).id(), target, list)));
    }

    /** 狀態與結果 */
    @GetMapping("/v1/ai/locate/{jobId}")
    public LocateJobs.View view(@PathVariable String jobId, HttpServletRequest req) {
        return jobs.view(token(req).id(), jobId);
    }

    @ExceptionHandler(LocateJobs.NotFoundException.class)
    ResponseEntity<Map<String, String>> notFound() {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "not-found"));
    }

    @ExceptionHandler({IllegalArgumentException.class, tools.jackson.core.JacksonException.class})
    ResponseEntity<Map<String, String>> bad() {
        return ResponseEntity.badRequest().body(Map.of("error", "bad-request"));
    }

    @ExceptionHandler(java.util.concurrent.RejectedExecutionException.class)
    ResponseEntity<Map<String, String>> busy() {
        return ResponseEntity.status(HttpStatus.TOO_MANY_REQUESTS).header("Retry-After", "10").body(Map.of("error", "locate-busy"));
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    ResponseEntity<Map<String, String>> tooLarge() {
        return ResponseEntity.status(HttpStatus.CONTENT_TOO_LARGE).body(Map.of("error", "frames-too-large"));
    }

    private static TokenInfo token(HttpServletRequest req) {
        return (TokenInfo) req.getAttribute(TokenAuthInterceptor.ATTR);
    }
}
