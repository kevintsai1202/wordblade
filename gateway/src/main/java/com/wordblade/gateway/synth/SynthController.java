package com.wordblade.gateway.synth;

import com.wordblade.gateway.ai.AiJobs;
import com.wordblade.gateway.auth.TokenAuthInterceptor;
import com.wordblade.gateway.auth.TokenService.TokenInfo;
import jakarta.servlet.http.HttpServletRequest;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;
import tools.jackson.databind.JsonNode;

/**
 * AI 音效與 AI 音樂（spec §5.15、D27）：POST /v1/ai/sound、/v1/ai/music 開始 → GET …/{jobId} 輪詢。
 * 回應只有結構化欄位：拒答代碼，或驗證過的宣告式 spec（桌面再算成 WAV）。
 */
@RestController
public class SynthController {

    /** 描述最多幾字 */
    static final int MAX_DESCRIPTION = 300;
    /** 前一版 spec 序列化後最多幾字元 */
    static final int MAX_PREVIOUS = 60_000;

    private final SoundJobs sound;
    private final MusicJobs music;

    public SynthController(SoundJobs sound, MusicJobs music) {
        this.sound = sound;
        this.music = music;
    }

    /** 開始 AI 音效 */
    @PostMapping("/v1/ai/sound")
    public ResponseEntity<Map<String, String>> startSound(@RequestBody SoundRequest body, HttpServletRequest req) {
        String problem = validate(body);
        if (problem != null) return ResponseEntity.badRequest().body(Map.of("error", problem));
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("jobId", sound.start(token(req).id(), body)));
    }

    /** AI 音效的狀態與結果 */
    @GetMapping("/v1/ai/sound/{jobId}")
    public AiJobs.View<SynthParser.Result> viewSound(@PathVariable String jobId, HttpServletRequest req) {
        return sound.view(token(req).id(), jobId);
    }

    /** 開始 AI 音樂 */
    @PostMapping("/v1/ai/music")
    public ResponseEntity<Map<String, String>> startMusic(@RequestBody MusicRequest body, HttpServletRequest req) {
        String problem = validate(body);
        if (problem != null) return ResponseEntity.badRequest().body(Map.of("error", problem));
        return ResponseEntity.status(HttpStatus.ACCEPTED).body(Map.of("jobId", music.start(token(req).id(), body)));
    }

    /** AI 音樂的狀態與結果 */
    @GetMapping("/v1/ai/music/{jobId}")
    public AiJobs.View<SynthParser.Result> viewMusic(@PathVariable String jobId, HttpServletRequest req) {
        return music.view(token(req).id(), jobId);
    }

    @ExceptionHandler(AiJobs.NotFoundException.class)
    ResponseEntity<Map<String, String>> notFound() {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(Map.of("error", "job-not-found"));
    }

    /** 驗證攔截器放進 request 的身分 */
    private static TokenInfo token(HttpServletRequest req) {
        return (TokenInfo) req.getAttribute(TokenAuthInterceptor.ATTR);
    }

    /** 檢查音效請求；不合格回錯誤代碼 */
    static String validate(SoundRequest b) {
        if (b == null || badDescription(b.description())) return "description";
        if (!(b.length() >= 0.05 && b.length() <= 10)) return "length";
        return badPrevious(b.previous()) ? "previous" : null;
    }

    /** 檢查配樂請求；不合格回錯誤代碼 */
    static String validate(MusicRequest b) {
        if (b == null || badDescription(b.description())) return "description";
        if (b.bars() < 1 || b.bars() > 32) return "bars";
        return badPrevious(b.previous()) ? "previous" : null;
    }

    /** 描述是空的或太長 */
    private static boolean badDescription(String d) {
        return d == null || d.isBlank() || d.length() > MAX_DESCRIPTION;
    }

    /** 前一版 spec 不是物件或太大 */
    private static boolean badPrevious(JsonNode p) {
        return p != null && !p.isNull() && (!p.isObject() || p.toString().length() > MAX_PREVIOUS);
    }
}
