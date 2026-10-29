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

    /** 三個章節：0–40、40–75、75–100 */
    private static final String CHAPTERS = """
            "chapters":[{"title":"Setup","start":0,"end":40},{"title":"Write the script","start":40,"end":75},{"title":"Run it","start":75,"end":100}]""";

    @Test
    void 合格的腳本_章節與各種項目_依時間排序_目的與引用帶回() {
        var r = check("{" + CHAPTERS + """
                ,"items":[
                 {"id":"i1","kind":"cut","start":10,"end":14,"chapter":0,"purpose":"Remove the retake","quote":"sorry, let me say that again"},
                 {"id":"i2","kind":"mask","start":30,"end":38,"chapter":0,"purpose":"Hide the API key","target":"API key","x":0.28,"y":0.07,"w":0.25,"h":0.03},
                 {"id":"i3","kind":"transition","start":39,"end":43,"chapter":1,"purpose":"Move from setup to writing code","quote":"Now let's write the main script.","scene":"desk-reveal","fromChapter":0,"toChapter":1},
                 {"id":"i4","kind":"zoom","start":44,"end":58,"chapter":1,"purpose":"Show the code being typed","quote":"We load the key with dotenv","activity":"a1"},
                 {"id":"i5","kind":"effect","start":80,"end":84,"chapter":2,"purpose":"Celebrate the result","quote":"And there it is","description":"A bright box pops around the three bullet points"},
                 {"id":"i6","kind":"mascot","start":88,"end":92,"chapter":2,"purpose":"Point at the timing","quote":"that took about four seconds","x":0.6,"y":0.7,"w":0.2,"h":0.1,"action":"point"},
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
                 {"id":"i1","kind":"effect","start":80,"end":84,"purpose":"","quote":"x","description":"d"},
                 {"id":"i2","kind":"zoom","start":44,"end":50,"purpose":"Show code","activity":"a1"}
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
                 {"id":"i1","kind":"transition","start":20,"end":24,"purpose":"p","quote":"q","scene":"desk-reveal"},
                 {"id":"i2","kind":"transition","start":39,"end":49,"purpose":"p","quote":"q","scene":"desk-reveal"},
                 {"id":"i3","kind":"camera","start":74,"end":77,"purpose":"p","quote":"q","scene":"board-float"}
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
                 {"id":"i1","kind":"effect","start":80,"end":83,"purpose":"p","quote":"q","description":"d"},
                 {"id":"i2","kind":"effect","start":90,"end":93,"purpose":"p","quote":"q","description":"d"},
                 {"id":"i3","kind":"zoom","start":81,"end":86,"purpose":"p","quote":"q","activity":"a2"},
                 {"id":"i4","kind":"zoom","start":44,"end":50,"purpose":"p","quote":"q","activity":"nope"}
                ]}""");
        assertThat(r.suggestions()).extracting(DirectorRules.Suggestion::id).containsExactly("i1");
        assertThat(r.errors()).extracting(e -> e.message())
                .anyMatch(m -> m.contains("20 seconds")).anyMatch(m -> m.contains("overlaps")).anyMatch(m -> m.contains("activity"));
    }

    @Test
    void 吉祥物要有目標框_最多一次_字幕樣式與片頭欄位要對() {
        var r = check("{" + CHAPTERS + """
                ,"items":[
                 {"id":"i1","kind":"mascot","start":88,"end":92,"purpose":"p","quote":"q"},
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
                 {"id":"i1","kind":"cut","start":10,"end":14,"purpose":"p","quote":"q"},
                 {"id":"i2","kind":"cut","start":13,"end":16,"purpose":"p","quote":"q"},
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
}
