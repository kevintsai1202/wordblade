package com.wordblade.gateway.director;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Set;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/**
 * 導演指示（docs/plan-11-01-directives.md）：使用者寫的指示 d1、d2…是規劃的一部分。
 * - 規劃者在 treatment.directives 逐條交代：用哪些項目做到（items），或為什麼不採用（notAdopted）；漏交代就退回。
 * - 照指示做的項目（"directive":"d1"）不受風格、次數上限、特效密度、problem、quote 限制；時間長度、重疊等硬規則照樣檢查。
 * - 照指示做的項目被規則擋下、又沒寫理由時，最後一輪把規則的錯誤當成不採用的理由（使用者一定看得到原因）。
 */
class DirectorDirectivesTest {

    private final JsonMapper json = JsonMapper.builder().build();
    private static final List<String> DIRECTIVES = List.of("在 68 到 74 秒讓玩偶從左邊走到 Spring MVC 那段字", "在 30 秒加一個特效");

    private static final String HEAD = """
            "chapters":[{"title":"Intro","start":0,"end":100}]""";

    private DirectorRules.Result check(String treatment, String items) {
        JsonNode root = json.readTree("{" + HEAD + (treatment == null ? "" : ",\"treatment\":" + treatment) + ",\"items\":[" + items + "]}");
        return DirectorRules.check(root, 100, Set.of(), Set.of(), Set.of(),
                new DirectorRules.Options("plain", Set.of(), List.of(), List.of(), DIRECTIVES, null));
    }

    /** 對帳清單裡某條指示 */
    private static JsonNode ledger(DirectorRules.Result r, String id) {
        for (JsonNode d : r.treatment().path("directives")) if (d.path("id").asString("").equals(id)) return d;
        throw new AssertionError("no ledger entry " + id);
    }

    @Test
    void 照指示做的玩偶_plain_也能用_不必_problem_與_quote_走路動作與方向帶回() {
        var r = check("""
                {"problems":[],"directives":[{"id":"d1","items":["i1"]},{"id":"d2","notAdopted":"There is nothing on screen at 30 s worth a callout."}]}""", """
                {"id":"i1","kind":"mascot","start":68,"end":74,"directive":"d1","purpose":"Walk to the Spring MVC text as asked","x":0.4,"y":0.3,"w":0.2,"h":0.1,"action":"walk","from":"left"}""");
        assertThat(r.errors()).isEmpty();
        DirectorRules.Suggestion m = r.suggestions().getFirst();
        assertThat(m.payload()).containsEntry("action", "walk").containsEntry("from", "left").containsEntry("directive", "d1");
        assertThat(ledger(r, "d1").path("items").get(0).asString()).isEqualTo("i1");
        assertThat(ledger(r, "d1").path("text").asString()).contains("玩偶");
        assertThat(ledger(r, "d2").path("notAdopted").asString()).contains("nothing on screen");
    }

    @Test
    void 指示沒交代_或項目指到不存在的指示_退回() {
        var r = check("""
                {"problems":[],"directives":[{"id":"d1","items":["i1"]}]}""", """
                {"id":"i1","kind":"mascot","start":68,"end":74,"directive":"d1","purpose":"p","x":0.4,"y":0.3,"w":0.2,"h":0.1,"action":"walk"},
                {"id":"i2","kind":"mascot","start":80,"end":84,"directive":"d9","purpose":"p","x":0.4,"y":0.3,"w":0.2,"h":0.1}""");
        assertThat(r.errors()).extracting(e -> e.message()).anyMatch(m -> m.contains("d2")).anyMatch(m -> m.contains("d9"));
        // 沒交代的 d2 先標成未交代（下一輪規劃者補）
        assertThat(ledger(r, "d2").path("notAdopted").asString()).isNotBlank();
    }

    @Test
    void 照指示做的項目被硬規則擋下_沒寫理由_規則錯誤當成不採用的理由() {
        // 兩個玩偶重疊：第二個被擋下；d2 只有被擋下的那一項
        var r = check("""
                {"problems":[],"directives":[{"id":"d1","items":["i1"]},{"id":"d2","items":["i2"]}]}""", """
                {"id":"i1","kind":"mascot","start":28,"end":34,"directive":"d1","purpose":"p","x":0.4,"y":0.3,"w":0.2,"h":0.1,"action":"walk"},
                {"id":"i2","kind":"effect","start":30,"end":33,"directive":"d2","purpose":"p","description":"a ring pulses around the title","x":0.4,"y":0.3,"w":0.2,"h":0.1}""");
        assertThat(r.errors()).isNotEmpty();
        assertThat(ledger(r, "d2").path("items").isEmpty()).isTrue();
        assertThat(ledger(r, "d2").path("notAdopted").asString()).contains("overlaps");
    }

    @Test
    void 照指示做的項目不受次數上限與特效密度限制() {
        var r = check("""
                {"problems":[],"directives":[{"id":"d1","items":["i1","i2"]},{"id":"d2","items":["i3","i4"]}]}""", """
                {"id":"i1","kind":"mascot","start":10,"end":14,"directive":"d1","purpose":"p","x":0.4,"y":0.3,"w":0.2,"h":0.1},
                {"id":"i2","kind":"mascot","start":20,"end":24,"directive":"d1","purpose":"p","x":0.4,"y":0.3,"w":0.2,"h":0.1,"action":"wave"},
                {"id":"i3","kind":"effect","start":30,"end":33,"directive":"d2","purpose":"p","description":"ring","x":0.4,"y":0.3,"w":0.2,"h":0.1},
                {"id":"i4","kind":"effect","start":40,"end":43,"directive":"d2","purpose":"p","description":"ring","x":0.4,"y":0.3,"w":0.2,"h":0.1}""");
        assertThat(r.errors()).isEmpty();
        assertThat(r.suggestions()).hasSize(4);
    }

    @Test
    void 這一輪漏了對帳清單_沿用上一輪的() {
        JsonNode previous = json.readTree("""
                [{"id":"d1","items":["i1"]},{"id":"d2","notAdopted":"nothing to point at"}]""");
        JsonNode root = json.readTree("{" + HEAD + """
                ,"items":[{"id":"i1","kind":"mascot","start":68,"end":74,"directive":"d1","purpose":"p","x":0.4,"y":0.3,"w":0.2,"h":0.1}]}""");
        var r = DirectorRules.check(root, 100, Set.of(), Set.of(), Set.of(), new DirectorRules.Options("plain", Set.of(), List.of(), List.of(), DIRECTIVES, previous));
        assertThat(r.errors()).isEmpty();
        assertThat(ledger(r, "d2").path("notAdopted").asString()).isEqualTo("nothing to point at");
    }

    @Test
    void 沒有指示時_舊的規則不變_plain_不能用玩偶() {
        JsonNode root = json.readTree("{" + HEAD + """
                ,"treatment":{"problems":[{"id":"p1","start":0,"end":5,"what":"x"}]},
                "items":[{"id":"i1","kind":"mascot","start":68,"end":74,"problem":"p1","quote":"q","purpose":"p","x":0.4,"y":0.3,"w":0.2,"h":0.1}]}""");
        var r = DirectorRules.check(root, 100, Set.of(), Set.of(), Set.of(), new DirectorRules.Options("plain", Set.of()));
        assertThat(r.suggestions()).isEmpty();
        assertThat(r.treatment().has("directives")).isFalse();
    }

    @Test
    void 玩偶至少三秒() {
        var r = check("""
                {"problems":[],"directives":[{"id":"d1","items":["i1"]},{"id":"d2","notAdopted":"n"}]}""", """
                {"id":"i1","kind":"mascot","start":68,"end":70,"directive":"d1","purpose":"p","x":0.4,"y":0.3,"w":0.2,"h":0.1,"action":"walk"}""");
        assertThat(r.suggestions()).isEmpty();
        assertThat(ledger(r, "d1").path("notAdopted").asString()).contains("3 seconds");
    }

    @Test
    void 照指示做的項目整段落在剪掉的範圍_含程式決定的剪_擋下並當成不採用的理由() {
        JsonNode root = json.readTree("{" + HEAD + """
                ,"treatment":{"problems":[],"directives":[{"id":"d1","items":["i1"]},{"id":"d2","items":["i2"]}]},
                "items":[{"id":"i1","kind":"mascot","start":40,"end":45,"directive":"d1","purpose":"p","x":0.4,"y":0.3,"w":0.2,"h":0.1},
                         {"id":"i2","kind":"mascot","start":70,"end":75,"directive":"d2","purpose":"p","x":0.4,"y":0.3,"w":0.2,"h":0.1}]}""");
        var r = DirectorRules.check(root, 100, Set.of(), Set.of(), Set.of(),
                new DirectorRules.Options("plain", Set.of(), List.of(), List.of(), DIRECTIVES, null, List.of(new double[] {19, 66.4})));
        assertThat(r.suggestions()).extracting(DirectorRules.Suggestion::id).containsExactly("i2");
        assertThat(ledger(r, "d1").path("notAdopted").asString()).contains("inside the cut");
        assertThat(ledger(r, "d2").path("items").size()).isEqualTo(1);
    }
}
