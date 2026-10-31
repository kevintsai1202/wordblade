package com.wordblade.gateway.director;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.http.MediaType;
import org.springframework.web.client.RestClient;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 用 TypeSafe Jev 判斷重講候選（docs/plan-10-31-director4.md）：POST /v1/systemone，一對句子一次問四題 Noul——
 * later 重講 earlier、earlier 是放棄的碎片、later 補充 earlier 漏講的、later 有沒有講完整；另外每一句一題「講完整了沒有」。
 * 回機率（0～1），同樣的輸入結果穩定。2026-10-31 先試過三選一 Choice，中文重講判錯 2 題，改成分開的 Noul（16 題全對）。
 * 2026-10-31 實測（scripts/director/probe-jev-retake.mjs）：中英文 7 題全對，每題約 0.2 秒、500 tokens。
 */
public class RestJevRetakeJudge implements DirectorJobs.RetakeJudge {

    /** 給 Jev 的背景說明 */
    private static final String CONTEXT = "Transcript of a screen-recorded tutorial. `earlier` is said first, `later` is said right after it.";

    private final RestClient rest;
    private final String model;
    private final JsonMapper json;

    /**
     * @param rest  已設好 base URL（https://api.typesafe.ai）與 Bearer 金鑰的 RestClient
     * @param model Jev 模型名稱（jev-latest）
     */
    public RestJevRetakeJudge(RestClient rest, String model, JsonMapper json) {
        this.rest = rest;
        this.model = model;
        this.json = json;
    }

    @Override
    public DirectorJobs.RetakeVerdict judge(String earlier, String later) {
        Map<String, Object> questions = new LinkedHashMap<>();
        questions.put("retake", Map.of(
                "type", "noul",
                "instructions", "The speaker abandons or fumbles `earlier` and says the same content again in `later`, so an editor should cut `earlier` and keep `later`.",
                "criteria", Map.of(
                        "true", "`later` is a new attempt at what `earlier` was saying (same point, possibly reworded, possibly more complete).",
                        "false", "`later` moves on to the next point, adds new information, or summarises; `earlier` is needed for the content.")));
        questions.put("falseStart", Map.of("type", "noul",
                "instructions", "`earlier` is an abandoned false start: the speaker stops before saying anything the viewer needs, then starts over in `later`."));
        questions.put("supplement", Map.of("type", "noul",
                "instructions", "In `later` the speaker adds something they forgot or left out about `earlier` (for example \"oh, I forgot to mention\"), so both parts are needed."));
        questions.put("complete", Map.of("type", "noul", "instructions", "`later` delivers the point completely; the speaker does not abandon it halfway."));
        Map<String, Object> body = Map.of("model", model, "state", Map.of("context", CONTEXT, "earlier", earlier, "later", later), "questions", questions);
        // 讀成位元組再以 UTF-8 解（同 ASR 的教訓：不靠回應標頭的 charset）
        byte[] reply = rest.post().uri("/v1/systemone").contentType(MediaType.APPLICATION_JSON)
                .body(json.writeValueAsString(body).getBytes(StandardCharsets.UTF_8)).retrieve().body(byte[].class);
        JsonNode root = json.readTree(new String(reply == null ? new byte[0] : reply, StandardCharsets.UTF_8));
        JsonNode a = root.path("answers");
        for (String k : java.util.List.of("retake", "falseStart", "supplement", "complete")) {
            if (!a.path(k).path("noul").isNumber()) throw new IllegalStateException("Jev reply has no answers");
        }
        return new DirectorJobs.RetakeVerdict(a.path("retake").path("noul").asDouble(), a.path("falseStart").path("noul").asDouble(),
                a.path("supplement").path("noul").asDouble(), a.path("complete").path("noul").asDouble(),
                root.path("usage").path("input_tokens").asLong(0), root.path("model").asString(model));
    }

    /** 每一句講完整了沒有：全部句子放在 state，一句一題 Noul，一次送出（2026-10-31 實測 8 題全對） */
    @Override
    public DirectorJobs.Completeness completeness(java.util.List<String> sentences) {
        Map<String, Object> questions = new LinkedHashMap<>();
        for (int i = 0; i < sentences.size(); i++) {
            questions.put("s" + i, Map.of("type", "noul", "instructions",
                    "`sentences[" + i + "]` is a complete thought: the speaker finishes what they set out to say, rather than trailing off or stopping halfway."));
        }
        Map<String, Object> body = Map.of("model", model,
                "state", Map.of("context", "Sentences from the transcript of a spoken screen-recorded tutorial, in order.", "sentences", sentences), "questions", questions);
        byte[] reply = rest.post().uri("/v1/systemone").contentType(MediaType.APPLICATION_JSON)
                .body(json.writeValueAsString(body).getBytes(StandardCharsets.UTF_8)).retrieve().body(byte[].class);
        JsonNode root = json.readTree(new String(reply == null ? new byte[0] : reply, StandardCharsets.UTF_8));
        java.util.List<Double> ps = new java.util.ArrayList<>();
        for (int i = 0; i < sentences.size(); i++) {
            JsonNode n = root.path("answers").path("s" + i).path("noul");
            if (!n.isNumber()) throw new IllegalStateException("Jev reply has no answer for sentence " + i);
            ps.add(n.asDouble());
        }
        return new DirectorJobs.Completeness(ps, root.path("usage").path("input_tokens").asLong(0), root.path("model").asString(model));
    }
}
