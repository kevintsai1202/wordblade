import { describe, expect, it } from "vitest";
import type { TimelineWord } from "../core/captions";
import type { GatewayKit } from "../ai/gateway";
import { generateKit } from "./run";

// 產生發佈包（spec §5.17）：成片逐字稿 → 閘道 → 章節對齊送出去的行首、套 YouTube 規則；語言自動判斷或指定。
const words: TimelineWord[] = [
  { id: "a", text: "Hello", start: 0, end: 0.4 }, { id: "b", text: "there.", start: 0.5, end: 0.9 },
  { id: "c", text: "Setup", start: 31, end: 31.5 }, { id: "d", text: "steps.", start: 31.6, end: 32 },
  { id: "e", text: "Demo", start: 95, end: 95.5 }, { id: "f", text: "time.", start: 95.6, end: 96 },
];

describe("generateKit", () => {
  it("送出分好的行與語言；章節對齊行首；選中第一個標題", async () => {
    const sent: unknown[] = [];
    const reply: GatewayKit = {
      titles: ["A", "B", "C"], description: "D", highlights: ["h"], tags: ["t"],
      chapters: [{ t: 1, title: "Intro" }, { t: 33, title: "Setup" }, { t: 94, title: "Demo" }],
    };
    const { kit, notice } = await generateKit({ publishKit: async (body) => { sent.push(body); return reply; } }, words, 120);
    expect(sent[0]).toEqual({ language: "en", duration: 120, lines: [{ t: 0, text: "Hello there." }, { t: 31, text: "Setup steps." }, { t: 95, text: "Demo time." }] });
    expect(kit).toMatchObject({ language: "en", title: 0, titles: ["A", "B", "C"] });
    expect(kit.chapters).toEqual([{ t: 0, title: "Intro" }, { t: 31, title: "Setup" }, { t: 95, title: "Demo" }]);
    expect(notice).toBeNull();
  });

  it("指定語言就用指定的；章節不夠 3 個時提示沒有章節", async () => {
    const sent: { language: string }[] = [];
    const { kit, notice } = await generateKit({ publishKit: async (body) => { sent.push(body); return { titles: ["A"], description: "", highlights: [], tags: [], chapters: [{ t: 0, title: "x" }] }; } }, words, 120, "zh");
    expect(sent[0].language).toBe("zh");
    expect(kit.chapters).toEqual([]);
    expect(notice).toMatch(/chapters/i);
  });

  it("沒有逐字稿就丟錯", async () => {
    await expect(generateKit({ publishKit: async () => { throw new Error("no"); } }, [], 10)).rejects.toThrow(/Transcribe/);
  });
});
