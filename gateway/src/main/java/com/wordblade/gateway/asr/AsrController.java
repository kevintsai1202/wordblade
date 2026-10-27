package com.wordblade.gateway.asr;

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
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MaxUploadSizeExceededException;
import org.springframework.web.multipart.MultipartFile;

/**
 * POST /v1/asr（spec §5.2、§6）：multipart 的 audio（16 kHz 單聲道 16-bit WAV，桌面已在無聲處切好段）
 * ＋選填的 keywords（可重複）→ Muse Voice Transcribe → {transcript, turns[{transcript, startMs, endMs, speaker}], audioDurationMs}。
 * 同步回應（每段幾分鐘的音訊約十幾秒到一分鐘）。
 */
@RestController
public class AsrController {

    private final AsrService service;

    public AsrController(AsrService service) {
        this.service = service;
    }

    /** 轉錄一段音訊 */
    @PostMapping(path = "/v1/asr", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public AsrResult transcribe(@RequestPart("audio") MultipartFile audio,
                                @RequestParam(value = "keywords", required = false) List<String> keywords,
                                HttpServletRequest req) throws IOException {
        TokenInfo token = (TokenInfo) req.getAttribute(TokenAuthInterceptor.ATTR);
        return service.transcribe(token.id(), audio.getBytes(), keywords);
    }

    @ExceptionHandler(WavInfo.BadWavException.class)
    ResponseEntity<Map<String, String>> badWav(WavInfo.BadWavException e) {
        return ResponseEntity.badRequest().body(Map.of("error", "bad-audio", "message", e.getMessage()));
    }

    @ExceptionHandler(MaxUploadSizeExceededException.class)
    ResponseEntity<Map<String, String>> tooLarge() {
        return ResponseEntity.status(HttpStatus.CONTENT_TOO_LARGE).body(Map.of("error", "audio-too-large"));
    }

    /** 上游忙（429）回 503 讓桌面稍後重試；其他錯誤回 502 */
    @ExceptionHandler(AsrUpstreamException.class)
    ResponseEntity<Map<String, String>> upstream(AsrUpstreamException e) {
        HttpStatus status = e.status() == 429 ? HttpStatus.SERVICE_UNAVAILABLE : HttpStatus.BAD_GATEWAY;
        return ResponseEntity.status(status).body(Map.of("error", e.status() == 429 ? "asr-busy" : "asr-failed"));
    }
}
