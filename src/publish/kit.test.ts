import { describe, expect, it } from "vitest";
import type { TimelineWord } from "../core/captions";
import { chaptersToText, detectLanguage, formatChapterTime, normalizeChapters, parseChapters, publishMarkdown, transcriptLines, trimLines, youtubeDescription, type PublishKit } from "./kit";

// 發佈包（spec §5.17）的純函式：成片逐字稿分行、語言判斷、章節整理（對齊行首＋YouTube 規則）、說明文字與 publish.md。
const w = (text: string, start: number, end = start + 0.3): TimelineWord => ({ id: `${text}@${start}`, text, start, end });

describe("transcriptLines：成片逐字稿分行", () => {
  it("停頓 ≥ 1 秒或一行超過 12 秒就換行；英文詞之間加空白、中文不加", () => {
    const words = [w("Hello", 0), w("world.", 0.4), w("Next", 2), w("part", 2.4), w("大家", 20), w("好", 20.3)];
    expect(transcriptLines(words)).toEqual([
      { t: 0, text: "Hello world." },
      { t: 2, text: "Next part" },
      { t: 20, text: "大家好" },
    ]);
    const long = Array.from({ length: 40 }, (_, i) => w(`w${i}`, i * 0.5));
    const lines = transcriptLines(long);
    expect(lines.length).toBe(2);
    expect(lines[1].t).toBeGreaterThanOrEqual(12);
  });

  it("超過上限就從中間截掉，留頭尾", () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ t: i * 10, text: "x".repeat(50) }));
    const { lines: kept, trimmed } = trimLines(lines, 2000);
    expect(trimmed).toBe(true);
    expect(kept[0].t).toBe(0);
    expect(kept[kept.length - 1].t).toBe(990);
    expect(kept.reduce((n, l) => n + l.text.length + 8, 0)).toBeLessThanOrEqual(2000);
    expect(trimLines(lines.slice(0, 3), 2000)).toEqual({ lines: lines.slice(0, 3), trimmed: false });
  });
});

describe("detectLanguage", () => {
  it("中文字多就是 zh，否則 en", () => {
    expect(detectLanguage("今天我們來看看 WordBlade 怎麼剪片")).toBe("zh");
    expect(detectLanguage("Today we look at how WordBlade edits video")).toBe("en");
    expect(detectLanguage("")).toBe("en");
  });
});

describe("normalizeChapters：對齊行首＋YouTube 規則", () => {
  const starts = [0, 12, 31, 47, 63, 95, 130];
  it("時間對齊最近的行首；±5 秒內沒有行首就丟掉；第一個改成 0:00", () => {
    const raw = [{ t: 2, title: "Intro" }, { t: 33, title: "Setup" }, { t: 80, title: "Ghost" }, { t: 96, title: "Demo" }];
    expect(normalizeChapters(raw, starts, 150)).toEqual([{ t: 0, title: "Intro" }, { t: 31, title: "Setup" }, { t: 95, title: "Demo" }]);
  });

  it("排序、相鄰 < 10 秒的只留前一個、超過片長的丟掉；少於 3 個就整組不要", () => {
    const raw = [{ t: 63, title: "C" }, { t: 0, title: "A" }, { t: 47, title: "B" }, { t: 47.5, title: "B2" }, { t: 130, title: "Too late" }];
    expect(normalizeChapters(raw, starts, 120)).toEqual([{ t: 0, title: "A" }, { t: 47, title: "B" }, { t: 63, title: "C" }]);
    expect(normalizeChapters([{ t: 0, title: "A" }, { t: 31, title: "B" }], starts, 120)).toEqual([]);
  });

  it("章節時間格式：m:ss，滿一小時 h:mm:ss", () => {
    expect(formatChapterTime(0)).toBe("0:00");
    expect(formatChapterTime(95.6)).toBe("1:35");
    expect(formatChapterTime(3725)).toBe("1:02:05");
  });
});

describe("說明文字與 publish.md", () => {
  const kit: PublishKit = {
    language: "en", titles: ["Edit by words", "Cut video like a doc", "WordBlade in 2 minutes"], title: 1,
    description: "How WordBlade edits video by editing the transcript.", highlights: ["Delete words to cut", "AI director"],
    chapters: [{ t: 0, title: "Intro" }, { t: 31, title: "Setup" }, { t: 95, title: "Demo" }], tags: ["video editing", "AI"],
  };

  it("YouTube 說明：說明＋重點條列＋章節（0:00 開頭）", () => {
    const text = youtubeDescription(kit);
    expect(text).toContain("How WordBlade edits video");
    expect(text).toContain("• Delete words to cut");
    expect(text).toMatch(/0:00 Intro\n0:31 Setup\n1:35 Demo/);
  });

  it("publish.md：選中的標題在最前、其他標題列為備選、標籤一行逗號分隔", () => {
    const md = publishMarkdown(kit);
    expect(md.startsWith("# Cut video like a doc\n")).toBe(true);
    expect(md).toContain("- Edit by words");
    expect(md).toContain("video editing, AI");
    expect(md).toContain("0:31 Setup");
  });
});

describe("章節文字的編輯", () => {
  it("一行一個「m:ss 標題」或「h:mm:ss 標題」；看不懂的行略過；轉回文字一樣", () => {
    const text = ["0:00 Intro", "0:31  Setup the tool", "not a chapter", "1:02:05 Late part", ""].join("\n");
    const chapters = parseChapters(text);
    expect(chapters).toEqual([{ t: 0, title: "Intro" }, { t: 31, title: "Setup the tool" }, { t: 3725, title: "Late part" }]);
    expect(chaptersToText(chapters)).toBe(["0:00 Intro", "0:31 Setup the tool", "1:02:05 Late part"].join("\n"));
  });
});
