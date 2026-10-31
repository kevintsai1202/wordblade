package com.wordblade.gateway.director;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/**
 * AI 導演剪輯腳本的檢查（docs/plan-10-29-director2.md）：Muse Wonder 回的 {chapters, items} → 章節＋合格的項目＋要回饋的錯誤。
 * 每項要有目的；剪／放大／特效／轉場／吉祥物要引用旁白；3D 轉場只能在章節交界；特效與轉場的密度；畫面類項目不重疊；整體項目（字幕樣式、配樂、片頭）。
 */
class DirectorRulesTest {

    private final JsonMapper json = JsonMapper.builder().build();
    private final Set<String> scenes = Set.of("board-float", "desk-reveal");
    private final Set<String> words = Set.of("m:w1", "m:w2");
    private final Set<String> activities = Set.of("a1", "a2");

    private DirectorRules.Result check(String text) {
        return DirectorRules.check(json.readTree(text), 100, scenes, words, activities);
    }

    /** 導演構想（問題 p1～p3）＋三個章節：0–40、40–75、75–100 */
    private static final String CHAPTERS = """
            "treatment":{"audience":"developers new to the OpenAI API","problems":[{"id":"p1","start":44,"end":58,"what":"code typed in small text"},
             {"id":"p2","start":78,"end":95,"what":"the result is easy to miss"},{"id":"p3","start":38,"end":44,"what":"new file opens"}]},
            "chapters":[{"title":"Setup","start":0,"end":40},{"title":"Write the script","start":40,"end":75},{"title":"Run it","start":75,"end":100}]""";

    @Test
    void 合格的腳本_章節與各種項目_依時間排序_目的與引用帶回() {
        var r = check("{" + CHAPTERS + """
                ,"items":[
                 {"id":"i1","kind":"cut","reason":"retake","start":10,"end":14,"chapter":0,"purpose":"Remove the retake","quote":"sorry, let me say that again"},
                 {"id":"i2","kind":"mask","start":30,"end":38,"chapter":0,"purpose":"Hide the API key","target":"API key","x":0.28,"y":0.07,"w":0.25,"h":0.03},
                 {"id":"i3","kind":"transition","start":39,"end":43,"chapter":1,"problem":"p3","purpose":"Move from setup to writing code","quote":"Now let's write the main script.","scene":"desk-reveal","fromChapter":0,"toChapter":1},
                 {"id":"i4","kind":"zoom","start":44,"end":58,"chapter":1,"problem":"p1","purpose":"Show the code being typed","quote":"We load the key with dotenv","activity":"a1"},
                 {"id":"i5","kind":"effect","start":80,"end":84,"chapter":2,"problem":"p2","purpose":"Celebrate the result","quote":"And there it is","description":"A bright box pops around the three bullet points"},
                 {"id":"i6","kind":"mascot","start":88,"end":92,"chapter":2,"problem":"p2","purpose":"Point at the timing","quote":"that took about four seconds","x":0.6,"y":0.7,"w":0.2,"h":0.1,"action":"point"},
                 {"id":"i7","kind":"fix","start":1,"end":2,"chapter":0,"purpose":"Misheard library name","wordIds":["m:w1"],"text":"dotenv"},
                 {"id":"i8","kind":"captionStyle","start":0,"end":100,"purpose":"Tutorial: follow along word by word","karaoke":"fill"},
                 {"id":"i9","kind":"music","start":0,"end":100,"purpose":"Light background under speech","description":"Soft lo-fi beat"},
                 {"id":"i10","kind":"intro","start":0,"end":1,"purpose":"Open with the topic","title":"Meeting Notes AI","subtitle":"a CLI in 2 minutes"}
                ]}""");
        assertThat(r.errors()).isEmpty();
        assertThat(r.chapters()).extracting(DirectorRules.Chapter::title).containsExactly("Setup", "Write the script", "Run it");
        assertThat(r.suggestions()).hasSize(10);
        DirectorRules.Suggestion zoom = r.suggestions().stream().filter(s -> s.kind().equals("zoom")).findFirst().orElseThrow();
        assertThat(zoom.purpose()).isEqualTo("Show the code being typed");
        assertThat(zoom.quote()).isEqualTo("We load the key with dotenv");
        assertThat(zoom.chapter()).isEqualTo(1);
        assertThat(zoom.payload()).isEqualTo(Map.of("activity", "a1"));
        // 整體項目：字幕樣式整支、配樂到片尾、片頭在開頭
        DirectorRules.Suggestion music = r.suggestions().stream().filter(s -> s.kind().equals("music")).findFirst().orElseThrow();
        assertThat(music.end()).isEqualTo(100.0);
        assertThat(r.suggestions().stream().filter(s -> s.kind().equals("transition")).findFirst().orElseThrow().payload())
                .containsEntry("scene", "desk-reveal").containsEntry("toChapter", 1);
    }

    @Test
    void 沒有目的_該引用旁白卻沒有_都退回() {
        var r = check("{" + CHAPTERS + """
                ,"items":[
                 {"id":"i1","kind":"effect","start":80,"end":84,"problem":"p2","purpose":"","quote":"x","description":"d"},
                 {"id":"i2","kind":"zoom","start":44,"end":50,"problem":"p1","purpose":"Show code","activity":"a1"}
                ]}""");
        assertThat(r.suggestions()).isEmpty();
        assertThat(r.errors()).hasSize(2);
        assertThat(r.errors().get(0).message()).contains("purpose");
        assertThat(r.errors().get(1).message()).contains("quote");
    }

    @Test
    void 轉場只能在章節交界_最多三個_相隔三十秒_長度二到六秒() {
        var r = check("{" + CHAPTERS + """
                ,"items":[
                 {"id":"i1","kind":"transition","start":20,"end":24,"problem":"p3","purpose":"p","quote":"q","scene":"desk-reveal"},
                 {"id":"i2","kind":"transition","start":39,"end":49,"problem":"p3","purpose":"p","quote":"q","scene":"desk-reveal"},
                 {"id":"i3","kind":"camera","start":74,"end":77,"problem":"p3","purpose":"p","quote":"q","scene":"board-float"}
                ]}""");
        // 20 秒不在交界；10 秒太長；camera 是舊名稱，當作 transition（75 秒是交界）
        assertThat(r.suggestions()).extracting(DirectorRules.Suggestion::kind).containsExactly("transition");
        assertThat(r.suggestions().get(0).start()).isEqualTo(74.0);
        assertThat(r.errors()).extracting(e -> e.message()).anyMatch(m -> m.contains("chapter boundary")).anyMatch(m -> m.contains("2 to 6 seconds"));
    }

    @Test
    void 特效每二十秒最多一個_畫面類項目不能重疊_放大的活動區要存在() {
        var r = check("{" + CHAPTERS + """
                ,"items":[
                 {"id":"i1","kind":"effect","start":80,"end":83,"problem":"p2","purpose":"p","quote":"q","description":"d"},
                 {"id":"i2","kind":"effect","start":90,"end":93,"problem":"p2","purpose":"p","quote":"q","description":"d"},
                 {"id":"i3","kind":"zoom","start":81,"end":88,"problem":"p1","purpose":"p","quote":"q","activity":"a2"},
                 {"id":"i4","kind":"zoom","start":44,"end":50,"problem":"p1","purpose":"p","quote":"q","activity":"nope"}
                ]}""");
        assertThat(r.suggestions()).extracting(DirectorRules.Suggestion::id).containsExactly("i1");
        assertThat(r.errors()).extracting(e -> e.message())
                .anyMatch(m -> m.contains("20 seconds")).anyMatch(m -> m.contains("overlaps")).anyMatch(m -> m.contains("activity"));
    }

    @Test
    void 吉祥物要有目標框_最多一次_字幕樣式與片頭欄位要對() {
        var r = check("{" + CHAPTERS + """
                ,"items":[
                 {"id":"i1","kind":"mascot","start":88,"end":92,"problem":"p2","purpose":"p","quote":"q"},
                 {"id":"i2","kind":"captionStyle","start":0,"end":100,"purpose":"p","karaoke":"rainbow"},
                 {"id":"i3","kind":"intro","start":0,"end":1,"purpose":"p","title":""}
                ]}""");
        assertThat(r.suggestions()).isEmpty();
        assertThat(r.errors()).hasSize(3);
    }

    @Test
    void 沒有章節或格式不對回錯誤() {
        assertThat(check("{\"items\":[]}").errors()).isNotEmpty();
        assertThat(check("[]").errors()).isNotEmpty();
    }

    @Test
    void 改字以詞為準_剪的重疊取聯集_遮罩的框選填() {
        var r = check("{" + CHAPTERS + """
                ,"items":[
                 {"id":"i1","kind":"cut","reason":"retake","start":10,"end":14,"purpose":"p","quote":"q"},
                 {"id":"i2","kind":"cut","reason":"retake","start":13,"end":16,"purpose":"p","quote":"q"},
                 {"id":"i3","kind":"fix","start":1,"end":2,"purpose":"p","wordIds":["m:w1"],"text":"Java"},
                 {"id":"i4","kind":"fix","start":1.5,"end":2.5,"purpose":"p","wordIds":["m:w2"],"text":"Maven"},
                 {"id":"i5","kind":"fix","start":3,"end":4,"purpose":"p","wordIds":["zz"],"text":"x"},
                 {"id":"i6","kind":"mask","start":30,"end":38,"purpose":"p","target":"human face"}
                ]}""");
        assertThat(r.suggestions()).extracting(DirectorRules.Suggestion::kind).containsExactly("fix", "fix", "cut", "mask");
        assertThat(r.suggestions().get(2).end()).isEqualTo(16.0);
        assertThat(r.errors()).hasSize(1);
        assertThat(r.suggestions().get(3).payload()).isEqualTo(Map.of("target", "human face"));
        assertThat(List.of(r.suggestions().get(0).id(), r.suggestions().get(1).id())).containsExactly("i3", "i4");
    }

    @Test
    void 畫面類項目要指名構想裡的問題_剪改字遮罩不用_導演構想帶回() {
        var r = check("{" + CHAPTERS + """
                ,"items":[
                 {"id":"i1","kind":"zoom","start":44,"end":52,"purpose":"p","quote":"q","activity":"a1"},
                 {"id":"i2","kind":"effect","start":80,"end":84,"problem":"p9","purpose":"p","quote":"q","description":"d"},
                 {"id":"i3","kind":"cut","reason":"retake","start":10,"end":14,"purpose":"p","quote":"q"},
                 {"id":"i4","kind":"zoom","start":60,"end":68,"problem":"p1","purpose":"p","quote":"q","activity":"a2"}
                ]}""");
        assertThat(r.suggestions()).extracting(DirectorRules.Suggestion::id).containsExactly("i3", "i4");
        assertThat(r.suggestions().get(1).problem()).isEqualTo("p1");
        assertThat(r.errors()).hasSize(2).allMatch(e -> e.message().contains("problem"));
        assertThat(r.problemIds()).containsExactlyInAnyOrder("p1", "p2", "p3");
        assertThat(r.treatment().path("audience").asString()).contains("developers");
    }

    @Test
    void 沒有導演構想時沿用上一輪的問題_都沒有就退回並要求補上構想() {
        String noTreatment = """
                {"chapters":[{"title":"All","start":0,"end":100}],"items":[
                 {"id":"i1","kind":"zoom","start":44,"end":52,"problem":"p1","purpose":"p","quote":"q","activity":"a1"}]}""";
        var reuse = DirectorRules.check(json.readTree(noTreatment), 100, scenes, words, activities, new DirectorRules.Options("playful", Set.of("p1")));
        assertThat(reuse.errors()).isEmpty();
        assertThat(reuse.problemIds()).containsExactly("p1");
        var none = check(noTreatment);
        assertThat(none.suggestions()).isEmpty();
        assertThat(none.errors()).extracting(e -> e.message()).anyMatch(m -> m.contains("treatment"));
    }

    @Test
    void 放大至少六秒_兩次放大至少相隔五秒() {
        var r = check("{" + CHAPTERS + """
                ,"items":[
                 {"id":"i1","kind":"zoom","start":44,"end":48,"problem":"p1","purpose":"p","quote":"q","activity":"a1"},
                 {"id":"i2","kind":"zoom","start":50,"end":58,"problem":"p1","purpose":"p","quote":"q","activity":"a1"},
                 {"id":"i3","kind":"zoom","start":60,"end":68,"problem":"p1","purpose":"p","quote":"q","activity":"a2"},
                 {"id":"i4","kind":"zoom","start":74,"end":82,"problem":"p2","purpose":"p","quote":"q","activity":"a2"}
                ]}""");
        assertThat(r.suggestions()).extracting(DirectorRules.Suggestion::id).containsExactly("i2", "i4");
        assertThat(r.errors()).extracting(e -> e.message()).anyMatch(m -> m.contains("6 seconds")).anyMatch(m -> m.contains("5 seconds"));
    }

    @Test
    void 風格決定能用哪些種類_plain_只有剪改字遮罩放大字幕片頭_沒給風格當_plain() {
        String all = "{" + CHAPTERS + """
                ,"items":[
                 {"id":"i1","kind":"zoom","start":44,"end":52,"problem":"p1","purpose":"p","quote":"q","activity":"a1"},
                 {"id":"i2","kind":"effect","start":80,"end":84,"problem":"p2","purpose":"p","quote":"q","description":"d"},
                 {"id":"i3","kind":"transition","start":39,"end":43,"problem":"p3","purpose":"p","quote":"q","scene":"desk-reveal"},
                 {"id":"i4","kind":"music","start":0,"end":100,"purpose":"p","description":"lo-fi"},
                 {"id":"i5","kind":"intro","start":0,"end":1,"purpose":"p","title":"T"}
                ]}""";
        var plain = DirectorRules.check(json.readTree(all), 100, scenes, words, activities, new DirectorRules.Options(null, Set.of()));
        assertThat(plain.suggestions()).extracting(DirectorRules.Suggestion::kind).containsExactlyInAnyOrder("zoom", "intro");
        assertThat(plain.errors()).hasSize(3).allMatch(e -> e.message().contains("not allowed in the \"plain\" style"));
        var light = DirectorRules.check(json.readTree(all), 100, scenes, words, activities, new DirectorRules.Options("light", Set.of()));
        assertThat(light.suggestions()).extracting(DirectorRules.Suggestion::kind).containsExactlyInAnyOrder("zoom", "effect", "music", "intro");
        assertThat(DirectorRules.allowedKinds("plain")).containsExactlyInAnyOrder("cut", "fix", "mask", "zoom", "captionStyle", "intro");
        assertThat(DirectorRules.allowedKinds("bogus")).isEqualTo(DirectorRules.allowedKinds("plain"));
    }

    @Test
    void 改字的詞部分重疊_後面那個退回_不同詞時間重疊沒關係() {
        var r = DirectorRules.check(json.readTree("{" + CHAPTERS + """
                ,"items":[
                 {"id":"i1","kind":"fix","start":26.2,"end":27.4,"purpose":"p","wordIds":["m:w1","m:w2"],"text":"Spring MVC"},
                 {"id":"i2","kind":"fix","start":26.8,"end":27.3,"purpose":"p","wordIds":["m:w2"],"text":"MVC"},
                 {"id":"i3","kind":"fix","start":27,"end":28,"purpose":"p","wordIds":["m:w3"],"text":"Boot"}
                ]}"""), 100, scenes, Set.of("m:w1", "m:w2", "m:w3"), activities);
        assertThat(r.suggestions()).extracting(DirectorRules.Suggestion::id).containsExactly("i1", "i3");
        assertThat(r.errors()).hasSize(1).allMatch(e -> e.message().contains("same words"));
    }

    /** 詞（素材時間）：中文逐字，每字 0.25 秒；英文逐詞 0.4 秒 */
    private static List<DirectorJobs.Word> zhWords(double start, String text, String prefix) {
        List<DirectorJobs.Word> out = new java.util.ArrayList<>();
        int i = 0;
        for (int cp : text.codePoints().toArray()) out.add(new DirectorJobs.Word(prefix + (i++), start + i * 0.25, new String(Character.toChars(cp))));
        return out;
    }

    /** 中文錄影：19 秒講一半、23.5～40 第一次開場、66 秒重錄、片尾 127 秒一聲 Hello */
    private static List<DirectorJobs.Word> lecture() {
        List<DirectorJobs.Word> w = new java.util.ArrayList<>();
        w.addAll(zhWords(19, "好我們接下來這個章節", "a"));
        w.addAll(zhWords(23.5, "我們接下來這個章節主要介紹框架它是很核心的功能那以前為什麼會叫做這個名字我們後面會講", "b"));
        w.addAll(zhWords(66, "好我們接下來這個章節會介紹一個很核心的套件叫做框架", "c"));
        w.add(new DirectorJobs.Word("z0", 127, "Hello"));
        return w;
    }

    private DirectorRules.Result checkWith(String items, List<DirectorJobs.Word> words, double duration) {
        Set<String> ids = new java.util.HashSet<>();
        words.forEach(x -> ids.add(x.id()));
        return DirectorRules.check(json.readTree("{\"chapters\":[{\"title\":\"All\",\"start\":0,\"end\":" + duration + "}],\"items\":[" + items + "]}"),
                duration, scenes, ids, activities, new DirectorRules.Options("plain", Set.of(), words));
    }

    @Test
    void 剪要標明種類_沒標或不認得的退回() {
        var r = checkWith("""
                {"id":"i1","kind":"cut","start":2,"end":10,"purpose":"p"},
                {"id":"i2","kind":"cut","start":2,"end":10,"purpose":"p","reason":"boring"}""", lecture(), 128.5);
        assertThat(r.suggestions()).isEmpty();
        assertThat(r.errors()).hasSize(2).allMatch(e -> e.message().contains("retake, silence, head, tail"));
    }

    @Test
    void 重講_後面六十秒內要有相近的重講_第一次開場加後面的空檔可以一起剪() {
        var r = checkWith("""
                {"id":"i1","kind":"cut","start":19,"end":23.5,"purpose":"p","reason":"retake","quote":"好我們接下來這個章節"},
                {"id":"i2","kind":"cut","start":23.5,"end":66,"purpose":"p","reason":"retake","quote":"我們接下來這個章節主要介紹"}""", lecture(), 128.5);
        assertThat(r.errors()).isEmpty();
        assertThat(r.suggestions()).extracting(DirectorRules.Suggestion::id).containsExactly("i1", "i2");
    }

    @Test
    void 重講_後面沒有相近的句子就退回_超過六十秒退回_沒有引用退回() {
        List<DirectorJobs.Word> w = new java.util.ArrayList<>(zhWords(10, "今天天氣很好我們去公園散步", "x"));
        w.addAll(zhWords(20, "下一個主題是資料庫的索引設計", "y"));
        var r = checkWith("""
                {"id":"i1","kind":"cut","start":9.5,"end":14,"purpose":"p","reason":"retake","quote":"今天天氣很好"},
                {"id":"i2","kind":"cut","start":0,"end":70,"purpose":"p","reason":"retake","quote":"今天"},
                {"id":"i3","kind":"cut","start":9.5,"end":14,"purpose":"p","reason":"retake"}""", w, 100);
        assertThat(r.suggestions()).isEmpty();
        assertThat(r.errors()).extracting(e -> e.message())
                .anyMatch(m -> m.contains("restart")).anyMatch(m -> m.contains("60 seconds")).anyMatch(m -> m.contains("quote"));
    }

    @Test
    void 沒講話_片頭_片尾_範圍內最多一個詞_片頭要從零開始_片尾要剪到最後() {
        var r = checkWith("""
                {"id":"i1","kind":"cut","start":0,"end":19,"purpose":"p","reason":"head"},
                {"id":"i2","kind":"cut","start":80,"end":128.5,"purpose":"p","reason":"tail"},
                {"id":"i3","kind":"cut","start":40,"end":60,"purpose":"p","reason":"silence"},
                {"id":"i4","kind":"cut","start":5,"end":19,"purpose":"p","reason":"head"},
                {"id":"i5","kind":"cut","start":23,"end":30,"purpose":"p","reason":"silence"},
                {"id":"i6","kind":"cut","start":100,"end":101,"purpose":"p","reason":"silence"}""", lecture(), 128.5);
        assertThat(r.suggestions()).extracting(DirectorRules.Suggestion::id).containsExactly("i1", "i3", "i2");
        assertThat(r.errors()).hasSize(3);
    }

    @Test
    void 改字_一項只改一個位置_最長一點五秒_詞要連續() {
        var r = checkWith("""
                {"id":"i1","kind":"fix","start":24,"end":24.6,"purpose":"p","wordIds":["b1","b2"],"text":"大家"},
                {"id":"i2","kind":"fix","start":24,"end":40,"purpose":"p","wordIds":["b5"],"text":"x"},
                {"id":"i3","kind":"fix","start":24,"end":25,"purpose":"p","wordIds":["b7","b9"],"text":"x"}""", lecture(), 128.5);
        assertThat(r.suggestions()).extracting(DirectorRules.Suggestion::id).containsExactly("i1");
        assertThat(r.errors()).extracting(e -> e.message()).anyMatch(m -> m.contains("1.5 seconds")).anyMatch(m -> m.contains("consecutive"));
    }

    @Test
    void 換句話說的重講_字面不像但對上_Jev_確認的候選就放行() {
        List<DirectorJobs.Word> w = new java.util.ArrayList<>(zhWords(10, "我們打開設定檔然後呃等一下", "x"));
        w.addAll(zhWords(20, "好來看一下這個專案的組態內容", "y"));
        String item = """
                {"id":"i1","kind":"cut","start":10,"end":20,"purpose":"p","reason":"retake","quote":"我們打開設定檔"}""";
        Set<String> ids = new java.util.HashSet<>();
        w.forEach(x -> ids.add(x.id()));
        var root = json.readTree("{\"chapters\":[{\"title\":\"All\",\"start\":0,\"end\":60}],\"items\":[" + item + "]}");
        var without = DirectorRules.check(root, 60, scenes, ids, activities, new DirectorRules.Options("plain", Set.of(), w));
        assertThat(without.suggestions()).isEmpty();
        var with = DirectorRules.check(root, 60, scenes, ids, activities, new DirectorRules.Options("plain", Set.of(), w, List.of(new double[] {10, 20.2})));
        assertThat(with.errors()).isEmpty();
        assertThat(with.suggestions()).hasSize(1);
    }
}
