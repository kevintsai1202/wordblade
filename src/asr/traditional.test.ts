import { describe, expect, it } from "vitest";
import type { Word } from "../core/model";
import { toTraditional } from "./traditional";

// 中文逐字稿一律用繁體（開發者 2026-10-31）：Muse ASR 對台灣口音也回簡體，轉錄完依原文判斷——
// 有漢字、沒有日文假名就轉成台灣繁體（含用語），英文與日文不動；時間與 id 不變。
const w = (id: string, text: string, start: number): Word => ({ id, mediaId: "m1", text, start, end: start + 0.3 });

describe("toTraditional", () => {
  it("簡體中文逐字轉台灣繁體：跨詞的用語也轉（软件→軟體），時間與 id 不變", async () => {
    const words = [w("w1", "软", 0), w("w2", "件", 0.3), w("w3", "开发，", 0.6), w("w4", "接下来", 1), w("w5", "Spring", 1.4)];
    const out = await toTraditional(words);
    expect(out.map((x) => x.text)).toEqual(["軟", "體", "開發，", "接下來", "Spring"]);
    expect(out.map((x) => [x.id, x.start, x.end])).toEqual(words.map((x) => [x.id, x.start, x.end]));
  });

  it("英文、已經是繁體、日文（有假名）都不動", async () => {
    const en = [w("a", "Hello", 0), w("b", "world.", 0.5)];
    expect(await toTraditional(en)).toBe(en);
    const ja = [w("c", "これは", 0), w("d", "软件です", 0.5)];
    expect(await toTraditional(ja)).toBe(ja);
    const tw = [w("e", "繁體", 0)];
    expect((await toTraditional(tw)).map((x) => x.text)).toEqual(["繁體"]);
  });

  it("中文逐字稿的半形標點轉全形（，？！：；，句號只在漢字後面）；Node.js、1,000 不動", async () => {
    const words = [w("a", "功能.", 0), w("b", "好,", 0.5), w("c", "那", 1), w("d", "MVC", 1.3), w("e", "?", 1.6), w("f", "Node.js", 2), w("g", "1,000", 2.5), w("h", "嗎?", 3)];
    expect((await toTraditional(words)).map((x) => x.text)).toEqual(["功能。", "好，", "那", "MVC", "？", "Node.js", "1,000", "嗎？"]);
  });
});
