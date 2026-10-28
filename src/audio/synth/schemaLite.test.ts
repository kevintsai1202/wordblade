import { describe, expect, it } from "vitest";
import { checkSchema, type JsonSchema } from "./schemaLite";

/** 測試用的小 schema：涵蓋 type、範圍、必填、enum、pattern、anyOf、$ref、陣列長度 */
const ROOT: JsonSchema = {
  $defs: {
    point: { type: "object", required: ["t", "v"], properties: { t: { type: "number", minimum: 0, maximum: 10 }, v: { type: "number" } } },
    curve: { anyOf: [{ type: "number", minimum: 20, maximum: 20000 }, { type: "array", minItems: 1, maxItems: 3, items: { $ref: "#/$defs/point" } }] },
    thing: {
      type: "object", required: ["name", "count"],
      properties: {
        name: { type: "string", pattern: "^[A-G]m?$" },
        count: { type: "integer", minimum: 1, maximum: 4 },
        kind: { enum: ["a", "b"] },
        freq: { $ref: "#/$defs/curve" },
      },
    },
  },
};

/** 檢查並回傳錯誤訊息 */
const errs = (v: unknown) => checkSchema(ROOT, "#/$defs/thing", v).errors;

describe("checkSchema（JSON Schema 子集）", () => {
  it("合格的值原樣通過，多餘欄位被丟掉", () => {
    const r = checkSchema(ROOT, "#/$defs/thing", { name: "Am", count: 2, kind: "b", freq: [{ t: 0, v: 1, note: "x" }], explanation: "hi" });
    expect(r.errors).toEqual([]);
    expect(r.value).toEqual({ name: "Am", count: 2, kind: "b", freq: [{ t: 0, v: 1 }] });
  });

  it("缺必填、型別不對、超出範圍都報錯並帶路徑", () => {
    expect(errs({ count: 2 }).join()).toContain("name");
    expect(errs({ name: "C", count: 1.5 }).join()).toContain("count 要是整數");
    expect(errs({ name: "C", count: 9 }).join()).toContain("count 要在 1～4 之間");
    expect(errs({ name: "C", count: "2" }).join()).toContain("count 要是整數");
    expect(errs("hello").join()).toContain("要是物件");
  });

  it("enum 與 pattern", () => {
    expect(errs({ name: "C", count: 1, kind: "c" }).join()).toContain("kind 只能是 a、b");
    expect(errs({ name: "H", count: 1 }).join()).toContain("name 格式不對");
  });

  it("anyOf：任一分支通過即可；都不過時回錯得最少的分支", () => {
    expect(errs({ name: "C", count: 1, freq: 440 })).toEqual([]);
    expect(errs({ name: "C", count: 1, freq: 5 }).join()).toContain("freq 要在 20～20000 之間");
    expect(errs({ name: "C", count: 1, freq: [{ t: 11, v: 1 }] }).join()).toContain("freq[0].t 要在 0～10 之間");
  });

  it("陣列長度上下限", () => {
    expect(errs({ name: "C", count: 1, freq: [] }).join()).toContain("freq");
    expect(errs({ name: "C", count: 1, freq: [{ t: 0, v: 1 }, { t: 1, v: 1 }, { t: 2, v: 1 }, { t: 3, v: 1 }] }).join()).toContain("最多 3 個");
  });

  it("NaN 與 Infinity 不算數字", () => {
    expect(errs({ name: "C", count: 1, freq: Number.NaN }).length).toBeGreaterThan(0);
    expect(errs({ name: "C", count: 1, freq: Infinity }).length).toBeGreaterThan(0);
  });
});
