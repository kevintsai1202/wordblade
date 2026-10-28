import { describe, expect, it } from "vitest";
import { coverRect, layoutTitle } from "./thumbnail";

// 縮圖（spec §5.12、§5.17）：底圖 cover 到 1280×720、標題換行（最多 2 行、放不下就縮字；中文逐字斷行）。
/** 假的量字：每個字寬 0.55 × 字級，中文字 1 × 字級 */
const measure = (text: string, size: number) => [...text].reduce((w, c) => w + (/[㐀-鿿]/.test(c) ? size : size * 0.55), 0);

describe("layoutTitle", () => {
  it("一行放得下就一行、用最大字級", () => {
    expect(layoutTitle("Edit by words", measure, 1100, { max: 110, min: 48 })).toEqual({ size: 110, lines: ["Edit by words"] });
  });

  it("太長就在空白處換成兩行；兩行還放不下就縮字", () => {
    const r = layoutTitle("Build a CLI Tool That Summarizes Meeting Notes with AI", measure, 1100, { max: 110, min: 48 });
    expect(r.lines).toHaveLength(2);
    expect(r.size).toBeLessThan(110);
    for (const line of r.lines) expect(measure(line, r.size)).toBeLessThanOrEqual(1100);
    expect(r.lines.join(" ")).toBe("Build a CLI Tool That Summarizes Meeting Notes with AI");
  });

  it("中文沒有空白：逐字斷行", () => {
    const r = layoutTitle("用逐字稿剪影片：刪字就是剪片，三分鐘學會", measure, 800, { max: 110, min: 40 });
    expect(r.lines.length).toBeLessThanOrEqual(2);
    expect(r.lines.join("")).toBe("用逐字稿剪影片：刪字就是剪片，三分鐘學會");
    for (const line of r.lines) expect(measure(line, r.size)).toBeLessThanOrEqual(800);
  });

  it("縮到最小還放不下：最小字級、第二行結尾加省略號", () => {
    const r = layoutTitle("word ".repeat(60).trim(), measure, 600, { max: 100, min: 40 });
    expect(r.size).toBe(40);
    expect(r.lines).toHaveLength(2);
    expect(r.lines[1].endsWith("…")).toBe(true);
    expect(measure(r.lines[1], 40)).toBeLessThanOrEqual(600);
  });
});

describe("coverRect：底圖鋪滿 16:9、裁掉多的", () => {
  it("比 16:9 寬的圖裁左右、比較高的裁上下（Muse Image 給的 2016×1152 是 1.75，裁上下）", () => {
    expect(coverRect(2016, 1152, 1280, 720)).toEqual({ sx: 0, sy: 9, sw: 2016, sh: 1134 });
    expect(coverRect(2560, 1080, 1280, 720)).toEqual({ sx: 320, sy: 0, sw: 1920, sh: 1080 });
    expect(coverRect(1000, 1000, 1280, 720)).toEqual({ sx: 0, sy: 218.75, sw: 1000, sh: 562.5 });
  });
});
