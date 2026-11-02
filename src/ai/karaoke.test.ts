// 卡拉 OK 重配錄音（P1-9；2026-11-02）的提詞時間
import { describe, expect, it } from "vitest";
import { makeProject } from "../core/fixtures";
import { prompterWords, activeWordIndex } from "./karaoke";
import { rangeText } from "./revoice";

describe("prompterWords", () => {
  const p = makeProject();
  const range = { start: 0, end: 3 };

  it("文字沒改：照原本的詞時間（相對範圍起點）", () => {
    const words = prompterWords(p, range, rangeText(p, range));
    expect(words.length).toBeGreaterThan(0);
    const original = rangeText(p, range).split(/\s+/);
    expect(words.map((w) => w.text)).toEqual(original);
    expect(words[0].start).toBeGreaterThanOrEqual(0);
    expect(words.every((w) => w.end <= 3)).toBe(true);
  });

  it("文字改過：依字數平均分到整段", () => {
    const words = prompterWords(p, range, "aa b ccc");
    expect(words.map((w) => w.text)).toEqual(["aa", "b", "ccc"]);
    expect(words[0]).toMatchObject({ start: 0, end: 1 });
    expect(words[2].end).toBeCloseTo(3);
  });

  it("目前念到第幾個字（還沒開始是 −1）", () => {
    const words = prompterWords(p, range, "aa b ccc");
    expect(activeWordIndex(words, -0.1)).toBe(-1);
    expect(activeWordIndex(words, 1.2)).toBe(1);
    expect(activeWordIndex(words, 9)).toBe(2);
  });
});
