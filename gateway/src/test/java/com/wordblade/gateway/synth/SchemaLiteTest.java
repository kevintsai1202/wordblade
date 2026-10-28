package com.wordblade.gateway.synth;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

/** JSON Schema 子集的檢查（和前端 src/audio/synth/schemaLite.ts 同一套規則）。 */
class SchemaLiteTest {

    private final JsonMapper json = JsonMapper.builder().build();

    /** 測試用的小 schema：type、範圍、必填、enum、pattern、anyOf、$ref、陣列長度 */
    private final JsonNode root = json.readTree("""
            {"$defs":{
              "point":{"type":"object","required":["t","v"],"properties":{"t":{"type":"number","minimum":0,"maximum":10},"v":{"type":"number"}}},
              "curve":{"anyOf":[{"type":"number","minimum":20,"maximum":20000},{"type":"array","minItems":1,"maxItems":3,"items":{"$ref":"#/$defs/point"}}]},
              "thing":{"type":"object","required":["name","count"],"properties":{
                "name":{"type":"string","pattern":"^[A-G]m?$"},
                "count":{"type":"integer","minimum":1,"maximum":4},
                "kind":{"enum":["a","b"]},
                "freq":{"$ref":"#/$defs/curve"}}}}}
            """);

    /** 檢查並回傳錯誤 */
    private List<String> errs(String value) {
        return SchemaLite.check(root, "#/$defs/thing", json.readTree(value)).errors();
    }

    @Test
    void 合格的值通過_多餘欄位被丟掉() {
        SchemaLite.Result r = SchemaLite.check(root, "#/$defs/thing", json.readTree("""
                {"name":"Am","count":2,"kind":"b","freq":[{"t":0,"v":1,"note":"x"}],"explanation":"hi"}"""));
        assertThat(r.errors()).isEmpty();
        assertThat(r.value()).isEqualTo(json.readTree("{\"name\":\"Am\",\"count\":2,\"kind\":\"b\",\"freq\":[{\"t\":0,\"v\":1}]}"));
    }

    @Test
    void 缺必填_型別不對_超出範圍() {
        assertThat(String.join("\n", errs("{\"count\":2}"))).contains("name");
        assertThat(String.join("\n", errs("{\"name\":\"C\",\"count\":1.5}"))).contains("count 要是整數");
        assertThat(String.join("\n", errs("{\"name\":\"C\",\"count\":9}"))).contains("count 要在 1～4 之間");
        assertThat(String.join("\n", errs("{\"name\":\"C\",\"count\":\"2\"}"))).contains("count 要是整數");
        assertThat(String.join("\n", errs("\"hello\""))).contains("要是物件");
    }

    @Test
    void enum與pattern() {
        assertThat(String.join("\n", errs("{\"name\":\"C\",\"count\":1,\"kind\":\"c\"}"))).contains("kind 只能是 a、b");
        assertThat(String.join("\n", errs("{\"name\":\"H\",\"count\":1}"))).contains("name 格式不對");
    }

    @Test
    void anyOf回形狀對得上的分支的錯() {
        assertThat(errs("{\"name\":\"C\",\"count\":1,\"freq\":440}")).isEmpty();
        assertThat(String.join("\n", errs("{\"name\":\"C\",\"count\":1,\"freq\":5}"))).contains("freq 要在 20～20000 之間");
        assertThat(String.join("\n", errs("{\"name\":\"C\",\"count\":1,\"freq\":[{\"t\":11,\"v\":1}]}"))).contains("freq[0].t 要在 0～10 之間");
    }

    @Test
    void 陣列長度上下限() {
        assertThat(String.join("\n", errs("{\"name\":\"C\",\"count\":1,\"freq\":[]}"))).contains("freq 至少要 1 個");
        assertThat(String.join("\n", errs("{\"name\":\"C\",\"count\":1,\"freq\":[{\"t\":0,\"v\":1},{\"t\":1,\"v\":1},{\"t\":2,\"v\":1},{\"t\":3,\"v\":1}]}")))
                .contains("最多 3 個");
    }
}
