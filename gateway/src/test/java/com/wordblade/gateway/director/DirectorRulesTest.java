package com.wordblade.gateway.director;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.json.JsonMapper;

/** AI 導演建議的檢查（Muse Wonder 的回應 → 合格的建議＋要回饋的錯誤）：時間、各種類欄位、場景與詞 id、同種重疊合併、上限。 */
class DirectorRulesTest {

    private final JsonMapper json = JsonMapper.builder().build();
    private final Set<String> scenes = Set.of("board-float", "desk-reveal");
    private final Set<String> words = Set.of("m:w1", "m:w2");

    private DirectorRules.Result check(String text) {
        return DirectorRules.check(json.readTree(text), 100, scenes, words);
    }

    @Test
    void 合格的六種建議_依時間排序_payload_分好() {
        var r = check("""
                {"suggestions":[
                 {"kind":"effect","start":50,"end":55,"reason":"Key moment","description":"A pop of confetti"},
                 {"kind":"cut","start":10,"end":14,"reason":"Retake"},
                 {"kind":"mask","start":30,"end":40,"reason":"API key","target":"API key","x":0.28,"y":0.07,"w":0.25,"h":0.03},
                 {"kind":"camera","start":60,"end":70,"reason":"Intro","scene":"desk-reveal","description":"Pull back slowly"},
                 {"kind":"fix","start":1,"end":2,"reason":"Misheard","wordIds":["m:w1","m:w2"],"text":"Java"},
                 {"kind":"zoom","start":80,"end":85,"reason":"Small text","cx":0.3,"cy":0.2,"w":0.4}
                ]}""");
        assertThat(r.errors()).isEmpty();
        assertThat(r.suggestions()).extracting(DirectorRules.Suggestion::kind).containsExactly("fix", "cut", "mask", "effect", "camera", "zoom");
        assertThat(r.suggestions().get(2).payload()).isEqualTo(Map.of("target", "API key", "x", 0.28, "y", 0.07, "w", 0.25, "h", 0.03));
        assertThat(r.suggestions().get(5).payload()).isEqualTo(Map.of("cx", 0.3, "cy", 0.2, "w", 0.4));
    }

    @Test
    void 不合格的回錯誤並丟掉_時間夾在片長內() {
        var r = check("""
                {"suggestions":[
                 {"kind":"camera","start":1,"end":5,"reason":"x","scene":"moon-base","description":"d"},
                 {"kind":"fix","start":1,"end":2,"reason":"x","wordIds":["nope"],"text":"Java"},
                 {"kind":"mask","start":3,"end":4,"reason":"x","target":"人臉"},
                 {"kind":"dance","start":3,"end":4,"reason":"x"},
                 {"kind":"cut","start":95,"end":130,"reason":"x"},
                 {"kind":"zoom","start":3,"end":4,"reason":"x","cx":2,"cy":0.5,"w":0.5}
                ]}""");
        assertThat(r.suggestions()).hasSize(1);
        assertThat(r.suggestions().get(0)).extracting(DirectorRules.Suggestion::start, DirectorRules.Suggestion::end).containsExactly(95.0, 100.0);
        assertThat(r.errors()).hasSize(5);
        assertThat(r.errors().get(0).message()).contains("moon-base");
    }

    @Test
    void 同種重疊合併_剪取聯集_其他留先出現的() {
        var r = check("""
                {"suggestions":[
                 {"kind":"cut","start":10,"end":14,"reason":"a"},
                 {"kind":"cut","start":13,"end":16,"reason":"b"},
                 {"kind":"effect","start":20,"end":25,"reason":"c","description":"x"},
                 {"kind":"effect","start":22,"end":24,"reason":"d","description":"y"},
                 {"kind":"zoom","start":20,"end":25,"reason":"e","cx":0.5,"cy":0.5,"w":0.5}
                ]}""");
        assertThat(r.suggestions()).extracting(DirectorRules.Suggestion::kind, DirectorRules.Suggestion::start, DirectorRules.Suggestion::end)
                .containsExactly(org.assertj.core.groups.Tuple.tuple("cut", 10.0, 16.0), org.assertj.core.groups.Tuple.tuple("effect", 20.0, 25.0), org.assertj.core.groups.Tuple.tuple("zoom", 20.0, 25.0));
    }

    @Test
    void 不是物件或沒有_suggestions_是格式錯誤() {
        assertThat(check("[1,2]").errors()).hasSize(1);
        assertThat(check("{\"x\":1}").errors()).hasSize(1);
    }

    @Test
    void 改字以詞為準_相鄰時間重疊也不互吃_同樣的詞才合併() {
        var r = check("""
                {"suggestions":[
                 {"kind":"fix","start":1,"end":1.5,"reason":"a","wordIds":["m:w1"],"text":"Java"},
                 {"kind":"fix","start":1.2,"end":1.7,"reason":"b","wordIds":["m:w2"],"text":"Maven"},
                 {"kind":"fix","start":1.0,"end":1.5,"reason":"c","wordIds":["m:w1"],"text":"Java"}
                ]}""");
        assertThat(r.suggestions()).hasSize(2);
    }

    @Test
    void 每種上限與總數上限() {
        StringBuilder sb = new StringBuilder("{\"suggestions\":[");
        java.util.Set<String> many = new java.util.HashSet<>();
        for (int i = 0; i < 40; i++) {
            many.add("m:w" + i);
            sb.append(i > 0 ? "," : "").append("{\"kind\":\"fix\",\"start\":").append(i * 2).append(",\"end\":").append(i * 2 + 1).append(",\"reason\":\"r\",\"wordIds\":[\"m:w").append(i).append("\"],\"text\":\"t\"}");
        }
        var r = DirectorRules.check(json.readTree(sb.append("]}").toString()), 100, scenes, many);
        assertThat(r.suggestions()).hasSize(DirectorRules.CAPS.get("fix"));
        assertThat(List.copyOf(r.suggestions())).allMatch(s -> s.kind().equals("fix"));
    }
}
