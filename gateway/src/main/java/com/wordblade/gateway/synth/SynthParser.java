package com.wordblade.gateway.synth;

import com.wordblade.gateway.ai.AiError;
import com.wordblade.gateway.ai.AiSchemaException;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;
import org.springframework.core.io.ClassPathResource;
import tools.jackson.core.JacksonException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ObjectNode;

/**
 * AI 音效與配樂（spec §5.15、D27）回應的解析與驗證：模型只回宣告式 JSON（不是程式碼），
 * 先用 JSON Schema（資源檔 synth/synth.schema.json，scripts/synth/build-prompt.mjs 從前端同步）檢查並丟掉多餘欄位，
 * 再做 schema 表達不了的語意檢查。規則與錯誤文字和前端 src/audio/synth/spec.ts 一致（共用 validationCases.json 測試）。
 */
public class SynthParser {

    /** 唯一的拒答代碼 */
    static final String REFUSAL = "off-topic";
    /** 配樂最長幾秒 */
    static final double MAX_MUSIC_SECONDS = 120;
    /** 配樂展開後最多幾個音 */
    static final int MAX_MUSIC_HITS = 3000;
    /** markdown 圍欄 */
    private static final Pattern FENCE = Pattern.compile("^```[a-zA-Z]*\\s*|\\s*```$");

    /**
     * 解析結果。
     *
     * @param refusal 拒答代碼；有 spec 時為 null
     * @param spec    清理過的 spec（只含 schema 列出的欄位）
     */
    public record Result(String refusal, ObjectNode spec) {}

    private final JsonMapper json;
    private final JsonNode schema;

    public SynthParser(JsonMapper json, JsonNode schema) {
        this.json = json;
        this.schema = schema;
    }

    /** 從資源檔 synth/synth.schema.json 建立 */
    public static SynthParser fromResources(JsonMapper json) {
        try {
            return new SynthParser(json, json.readTree(new ClassPathResource("synth/synth.schema.json").getContentAsString(StandardCharsets.UTF_8)));
        } catch (IOException e) {
            throw new UncheckedIOException(e);
        }
    }

    /** 解析音效回應；length 是使用者要求的長度（秒）。不合格丟 AiSchemaException */
    public Result parseSound(String text, double length) {
        JsonNode v = jsonObject(text);
        Result refusal = refusal(v);
        if (refusal != null) return refusal;
        SchemaLite.Result r = soundErrors(v);
        List<String> errors = new ArrayList<>(r.errors());
        if (errors.isEmpty() && Math.abs(r.value().get("length").doubleValue() - length) > 0.001) {
            errors.add("length 要是使用者要求的 " + SchemaLite.num(length) + " 秒");
        }
        if (!errors.isEmpty()) throw fail(errors);
        return new Result(null, (ObjectNode) r.value());
    }

    /** 解析配樂回應；bars 是使用者要求的小節數。不合格丟 AiSchemaException */
    public Result parseMusic(String text, int bars) {
        JsonNode v = jsonObject(text);
        Result refusal = refusal(v);
        if (refusal != null) return refusal;
        SchemaLite.Result r = musicErrors(v);
        List<String> errors = new ArrayList<>(r.errors());
        if (errors.isEmpty() && r.value().get("bars").asInt() != bars) errors.add("bars 要是使用者要求的 " + bars);
        if (!errors.isEmpty()) throw fail(errors);
        return new Result(null, (ObjectNode) r.value());
    }

    /** 音效 spec 的 schema 與語意檢查（聲部開始時間、振盪器頻率、曲線遞增） */
    public SchemaLite.Result soundErrors(JsonNode raw) {
        SchemaLite.Result r = SchemaLite.check(schema, "#/$defs/sound", raw);
        if (!r.errors().isEmpty()) return r;
        JsonNode spec = r.value();
        double length = spec.get("length").doubleValue();
        List<String> errors = new ArrayList<>();
        JsonNode voices = spec.get("voices");
        for (int i = 0; i < voices.size(); i++) {
            JsonNode v = voices.get(i);
            String path = "voices[" + i + "]";
            double start = v.path("start").doubleValue(0);
            if (start >= length) errors.add(path + ".start（" + SchemaLite.num(start) + " 秒）要小於總長度 " + SchemaLite.num(length) + " 秒");
            if (v.get("source").get("type").asString().equals("osc") && !v.get("source").has("freq")) errors.add(path + ".source.freq：音效的振盪器要有頻率");
            checkVoice(v, path, errors);
        }
        return new SchemaLite.Result(spec, errors);
    }

    /** 配樂 spec 的 schema 與語意檢查（聲部要有音色、音符要有音高、音符落在 loopBars 內、長度與總音數上限） */
    public SchemaLite.Result musicErrors(JsonNode raw) {
        SchemaLite.Result r = SchemaLite.check(schema, "#/$defs/music", raw);
        if (!r.errors().isEmpty()) return r;
        JsonNode spec = r.value();
        List<String> errors = new ArrayList<>();
        int bars = spec.get("bars").asInt();
        int bpb = spec.has("beatsPerBar") ? spec.get("beatsPerBar").asInt() : 4;
        double seconds = bars * bpb * 60.0 / spec.get("bpm").doubleValue();
        if (seconds > MAX_MUSIC_SECONDS) {
            errors.add("配樂長度 " + String.format(Locale.ROOT, "%.1f", seconds) + " 秒超過 " + SchemaLite.num(MAX_MUSIC_SECONDS) + " 秒；減少 bars 或加快 bpm");
        }
        JsonNode parts = spec.get("parts");
        for (int i = 0; i < parts.size(); i++) {
            JsonNode p = parts.get(i);
            String path = "parts[" + i + "]";
            boolean drums = p.get("role").asString().equals("drums");
            int loopBars = p.has("loopBars") ? p.get("loopBars").asInt() : bars;
            if (loopBars > bars) errors.add(path + ".loopBars（" + loopBars + "）不能超過 bars（" + bars + "）");
            if (!drums) {
                if (!p.has("voice")) errors.add(path + ".voice：drums 以外的聲部要有 voice");
                else checkVoice(p.get("voice"), path + ".voice", errors);
            }
            JsonNode notes = p.get("notes");
            for (int j = 0; j < notes.size(); j++) {
                JsonNode n = notes.get(j);
                String np = path + ".notes[" + j + "]";
                if (drums && !n.has("drum")) errors.add(np + "：鼓聲部的音符要有 drum");
                if (!drums && !n.has("pitch") && !n.has("chord")) errors.add(np + "：要有 pitch 或 chord");
                double at = n.get("at").doubleValue();
                if (at >= loopBars * bpb) errors.add(np + ".at（" + SchemaLite.num(at) + "）要小於 " + (loopBars * bpb) + " 拍（loopBars × beatsPerBar）");
            }
        }
        if (errors.isEmpty()) {
            long hits = hitCount(spec, bars, bpb);
            if (hits > MAX_MUSIC_HITS) errors.add("展開後有 " + hits + " 個音，超過 " + MAX_MUSIC_HITS + " 個；減少音符或小節數");
        }
        return new SchemaLite.Result(spec, errors);
    }

    /** 展開後的音數（和前端 musicGroups 一樣：音符表每 loopBars 小節重複到整首結束） */
    private static long hitCount(JsonNode spec, int bars, int bpb) {
        int totalBeats = bars * bpb;
        long count = 0;
        for (JsonNode p : spec.get("parts")) {
            int loopBeats = (p.has("loopBars") ? p.get("loopBars").asInt() : bars) * bpb;
            int reps = (int) Math.ceil((double) totalBeats / loopBeats);
            for (int r = 0; r < reps; r++) {
                for (JsonNode n : p.get("notes")) if (r * loopBeats + n.get("at").doubleValue() < totalBeats) count++;
            }
        }
        return count;
    }

    /** 音色的語意檢查：頻率與截止頻率的曲線，t 要嚴格遞增 */
    private static void checkVoice(JsonNode v, String path, List<String> errors) {
        if (v.get("source").get("type").asString().equals("osc")) checkCurve(v.get("source").get("freq"), path + ".source.freq", errors);
        if (v.has("filter")) checkCurve(v.get("filter").get("cutoff"), path + ".filter.cutoff", errors);
    }

    /** 曲線（{t, v} 點的陣列）的 t 要嚴格遞增 */
    private static void checkCurve(JsonNode curve, String path, List<String> errors) {
        if (curve == null || !curve.isArray()) return;
        for (int i = 1; i < curve.size(); i++) {
            if (curve.get(i).get("t").doubleValue() <= curve.get(i - 1).get("t").doubleValue()) {
                errors.add(path + " 的 t 要嚴格遞增");
                return;
            }
        }
    }

    /** {"refused": …}：只收 off-topic */
    private static Result refusal(JsonNode v) {
        if (!v.has("refused")) return null;
        if (!REFUSAL.equals(v.path("refused").asString(""))) throw fail(List.of("refused 只能是 off-topic"));
        return new Result(REFUSAL, null);
    }

    /** 從回應取出第一個 JSON 物件（容忍 ```json 圍欄與前後雜訊） */
    private JsonNode jsonObject(String text) {
        String t = text == null ? "" : text.strip();
        if (t.startsWith("```")) t = FENCE.matcher(t).replaceAll("");
        JsonNode v = tryRead(t);
        if (v == null) {
            int a = t.indexOf('{');
            int b = t.lastIndexOf('}');
            v = a >= 0 && b > a ? tryRead(t.substring(a, b + 1)) : null;
        }
        if (v == null || !v.isObject()) throw new AiSchemaException(List.of(new AiError("json", null, "回應不是 JSON 物件", null, null)));
        return v;
    }

    /** 讀 JSON，失敗回 null */
    private JsonNode tryRead(String t) {
        try {
            return json.readTree(t);
        } catch (JacksonException e) {
            return null;
        }
    }

    /** 錯誤清單 → 例外（每則一個 schema 階段的錯誤） */
    private static AiSchemaException fail(List<String> messages) {
        return new AiSchemaException(messages.stream().map(m -> new AiError("schema", null, m, null, null)).toList());
    }
}
