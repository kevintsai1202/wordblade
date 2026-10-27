import { describe, expect, it } from "vitest";
import type { Caption } from "../core/captions";
import { captionAt, captionLayout, DEFAULT_CAPTION_STYLE, wordStates } from "./captionLayout";

/** 假的量字：每個字元 0.5 × 字高 */
const measure = (text: string, px: number) => text.length * 0.5 * px;

/** 一段兩行的字幕 */
const caption: Caption = {
  id: "w1", start: 1, end: 4,
  lines: ["Hello there,", "general Kenobi"],
  lineWordIds: [["w1", "w2"], ["w3", "w4"]],
  wordIds: ["w1", "w2", "w3", "w4"],
};
/** 詞的時間 */
const times = new Map([["w1", { start: 1, end: 1.5 }], ["w2", { start: 1.6, end: 2 }], ["w3", { start: 2.5, end: 3 }], ["w4", { start: 3.1, end: 3.6 }]]);

describe("captionLayout", () => {
  it("字高＝畫面高 × size；兩行置中、最後一行的基線在離底 bottom 的位置", () => {
    const l = captionLayout(caption, 1920, 1080, DEFAULT_CAPTION_STYLE, measure);
    const px = Math.round(1080 * DEFAULT_CAPTION_STYLE.size);
    expect(l.fontPx).toBe(px);
    expect(l.lines).toHaveLength(2);
    const last = l.lines[1];
    expect(last.baseline).toBeCloseTo(1080 * (1 - DEFAULT_CAPTION_STYLE.bottom), 0);
    expect(l.lines[0].baseline).toBeLessThan(last.baseline);
    // 置中：第一個詞的左邊＋整行寬的一半＝畫面中央
    const first = l.lines[0];
    expect(first.x + first.width / 2).toBeCloseTo(960, 0);
    // 詞依序排、中間隔一個空白
    const [a, b] = first.words;
    expect(a.id).toBe("w1");
    expect(b.x).toBeCloseTo(a.x + a.width + measure(" ", px), 3);
  });

  it("最寬的一行超過畫面寬 90% 時整體縮小", () => {
    const narrow = captionLayout(caption, 400, 1080, DEFAULT_CAPTION_STYLE, measure);
    const widest = Math.max(...narrow.lines.map((l) => l.width));
    expect(widest).toBeLessThanOrEqual(400 * 0.9 + 0.5);
    expect(narrow.fontPx).toBeLessThan(Math.round(1080 * DEFAULT_CAPTION_STYLE.size));
  });
});

describe("wordStates（逐字高亮）", () => {
  it("講到的詞是 active，之前的 past、之後的 future；兩個詞之間的空檔維持上一個詞", () => {
    expect(wordStates(caption, times, 1.2)).toEqual({ w1: "active", w2: "future", w3: "future", w4: "future" });
    expect(wordStates(caption, times, 2.2)).toEqual({ w1: "past", w2: "active", w3: "future", w4: "future" });
    expect(wordStates(caption, times, 3.2)).toEqual({ w1: "past", w2: "past", w3: "past", w4: "active" });
  });

  it("第一個詞開始前全是 future；最後一個詞講完後全部 past（字幕延長顯示的那段）", () => {
    expect(Object.values(wordStates(caption, times, 0.9))).toEqual(["future", "future", "future", "future"]);
    expect(Object.values(wordStates(caption, times, 3.8))).toEqual(["past", "past", "past", "past"]);
  });
});

describe("captionAt", () => {
  it("時間 t 落在哪一段字幕（起點含、終點不含）", () => {
    const list = [caption, { ...caption, id: "w9", start: 4, end: 6 }];
    expect(captionAt(list, 3.99)?.id).toBe("w1");
    expect(captionAt(list, 4)?.id).toBe("w9");
    expect(captionAt(list, 6)).toBeNull();
  });
});
