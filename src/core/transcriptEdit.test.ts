import { describe, expect, it } from "vitest";
import { makeProject } from "./fixtures";
import { applyEdits } from "./history";
import { editWords } from "./transcriptEdit";

describe("editWords（改字）", () => {
  it("字數一樣：只換文字，id 與時間不變（字幕斷點保留）", () => {
    const p = makeProject();
    p.captionBreaks = [{ wordId: "w2", kind: "breakAfter" }];
    const next = editWords(p, ["w2"], "uhh");
    const w2 = next.words.find((w) => w.id === "w2")!;
    expect(w2).toMatchObject({ text: "uhh", start: 1.6, end: 2.0 });
    expect(next.captionBreaks).toHaveLength(1);
  });

  it("字數變了：在原本的總時間內依字數重新分配，新 id 不和別的詞重複，指到舊詞的斷點刪掉", () => {
    const p = makeProject();
    p.captionBreaks = [{ wordId: "w2", kind: "breakAfter" }];
    // w2 "um"（1.6～2.0）＋ w3 "world"（2.5～3.0）→ 三個詞，總時間 1.6～3.0
    const next = editWords(p, ["w2", "w3"], "big wide world");
    const m1 = next.words.filter((w) => w.mediaId === "m1").sort((a, b) => a.start - b.start);
    expect(m1.map((w) => w.text)).toEqual(["hello", "big", "wide", "world", "again"]);
    const [big, wide, world] = m1.slice(1, 4);
    expect(big.start).toBeCloseTo(1.6);
    expect(world.end).toBeCloseTo(3.0);
    expect(big.end).toBeCloseTo(wide.start);
    expect(wide.end).toBeCloseTo(world.start);
    // 依字數：world（5 字）比 big（3 字）長
    expect(world.end - world.start).toBeGreaterThan(big.end - big.start);
    expect(new Set(next.words.map((w) => w.id)).size).toBe(next.words.length);
    expect(next.captionBreaks).toHaveLength(0);
  });

  it("不連續、跨素材或空字串：不改", () => {
    const p = makeProject();
    expect(editWords(p, ["w1", "w3"], "x")).toBe(p);
    expect(editWords(p, ["w2"], "   ")).toBe(p);
    p.words.push({ id: "x1", mediaId: "m2", text: "other", start: 1, end: 2 });
    expect(editWords(p, ["w3", "x1"], "x")).toBe(p);
  });

  it("透過歷史的 editWords 編輯，可以復原", () => {
    const p = makeProject();
    const next = applyEdits(p, [{ kind: "editWords", wordIds: ["w3"], text: "earth" }]);
    expect(next.words.find((w) => w.id === "w3")!.text).toBe("earth");
    expect(p.words.find((w) => w.id === "w3")!.text).toBe("world");
  });
});
