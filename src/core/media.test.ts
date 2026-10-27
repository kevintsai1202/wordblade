import { describe, expect, it } from "vitest";
import { makeProject } from "./fixtures";
import { applyEdits } from "./history";
import { setMediaWords } from "./media";

describe("setMediaWords", () => {
  it("整批換掉這支素材的詞，其他素材的詞不動；依起點排序", () => {
    const p = makeProject();
    p.words.push({ id: "x1", mediaId: "m2", text: "other", start: 1, end: 2 });
    const next = setMediaWords(p, "m1", [
      { id: "m1:w1", mediaId: "m1", text: "b", start: 2, end: 3 },
      { id: "m1:w0", mediaId: "m1", text: "a", start: 0, end: 1 },
    ]);
    expect(next.words.filter((w) => w.mediaId === "m1").map((w) => w.text)).toEqual(["a", "b"]);
    expect(next.words.some((w) => w.id === "x1")).toBe(true);
    expect(next.words.some((w) => w.id === "w1")).toBe(false);
  });

  it("指到被換掉的詞的字幕斷點一起刪掉", () => {
    const p = makeProject();
    p.captionBreaks = [{ wordId: "w1", kind: "breakAfter" }, { wordId: "x9", kind: "joinAfter" }];
    const next = setMediaWords(p, "m1", []);
    expect(next.captionBreaks.map((b) => b.wordId)).toEqual(["x9"]);
  });

  it("透過歷史的 setWords 編輯可以復原", () => {
    const p = makeProject();
    const next = applyEdits(p, [{ kind: "setWords", mediaId: "m1", words: [] }]);
    expect(next.words.some((w) => w.mediaId === "m1")).toBe(false);
    expect(p.words.some((w) => w.mediaId === "m1")).toBe(true);
  });
});

describe("setCaptionStyle", () => {
  it("改字幕樣式（部分欄位），可以復原", () => {
    const p = makeProject();
    const next = applyEdits(p, [{ kind: "setCaptionStyle", style: { preset: "box", karaoke: "fill" } }]);
    expect(next.captionStyle).toMatchObject({ preset: "box", karaoke: "fill", size: 0.055 });
    const again = applyEdits(next, [{ kind: "setCaptionStyle", style: { size: 0.07 } }]);
    expect(again.captionStyle).toMatchObject({ preset: "box", size: 0.07 });
    expect(p.captionStyle).toBeUndefined();
  });
});
