import { describe, expect, it } from "vitest";
import { makeClip, makeProject } from "./fixtures";
import type { Project, Word } from "./model";
import { breakLines, buildCaptions, joinWords, timelineWords } from "./captions";

/** 用一串英文詞建逐字稿：每個詞 0.3 秒、詞間 0.05 秒；gapsAfter 指定某些詞後面的停頓 */
function wordsOf(text: string, gapsAfter: Record<number, number> = {}, mediaId = "m1"): Word[] {
  let t = 0;
  return text.split(" ").map((w, i) => {
    const word = { id: `w${i}`, mediaId, text: w, start: Math.round(t * 1000) / 1000, end: Math.round((t + 0.3) * 1000) / 1000 };
    t += 0.35 + (gapsAfter[i] ?? 0);
    return word;
  });
}

/** 專案：V1 只有一個 m1 的片段（素材 0～100 秒），逐字稿換成指定的詞 */
function projectWith(words: Word[]): Project {
  const p = makeProject();
  p.clips = [makeClip({ id: "c", mediaId: "m1", trackId: "V1", srcIn: 0, srcOut: 100, start: 0 })];
  p.words = words;
  return p;
}

describe("timelineWords", () => {
  it("把 V1 片段用到的詞換算到時間軸時間，片段外的詞不算", () => {
    const p = makeProject();
    // fixture：v1a 用 m1 0～10（時間軸 0～10）、v1b 用 m1 20～30（時間軸 10～20）
    const words = timelineWords(p);
    expect(words.map((w) => [w.id, w.start])).toEqual([["w1", 1], ["w2", 1.6], ["w3", 2.5], ["w4", 11]]);
  });
});

describe("breakLines", () => {
  it("一行放得下就不斷", () => {
    expect(breakLines(["This", "is", "short."], 42)).toEqual([["This", "is", "short."]]);
  });

  it("優先斷在逗號之後", () => {
    const lines = breakLines("When you install the tools, the terminal will show a new prompt".split(" "), 42);
    expect(lines.map((l) => l.join(" "))).toEqual(["When you install the tools,", "the terminal will show a new prompt"]);
  });

  it("沒有標點時斷在連接詞之前，而且冠詞、介系詞不留在行尾", () => {
    const lines = breakLines("We open the terminal window and then we type the first command".split(" "), 42);
    expect(lines[0].join(" ")).toBe("We open the terminal window");
    expect(lines[1][0]).toBe("and");
  });

  it("行數先求最少：開頭的逗號不會讓兩行能放下的句子變成三行", () => {
    const lines = breakLines("Okay, next let's talk about why we're installing all of this stuff.".split(" "), 42);
    expect(lines).toHaveLength(2);
    expect(lines[0].join(" ")).not.toBe("Okay,");
  });

  it("不拆開數字與單位", () => {
    const lines = breakLines("The installer is about one hundred and twenty 50 MB in total size here".split(" "), 42);
    for (const line of lines) expect(line[line.length - 1]).not.toBe("50");
  });
});

describe("buildCaptions", () => {
  it("句末標點斷句", () => {
    const p = projectWith(wordsOf("Hello there. Welcome to the course."));
    const caps = buildCaptions(p);
    expect(caps.map((c) => c.lines.join(" / "))).toEqual(["Hello there.", "Welcome to the course."]);
  });

  it("停頓 ≥ 0.5 秒也斷句", () => {
    const p = projectWith(wordsOf("first part second part", { 1: 0.6 }));
    expect(buildCaptions(p).map((c) => c.lines.join(" "))).toEqual(["first part", "second part"]);
  });

  it("CaptionBreak：joinAfter 取消斷點、breakAfter 強制斷點", () => {
    const p = projectWith(wordsOf("Hello there. Welcome to the course."));
    p.captionBreaks = [{ wordId: "w1", kind: "joinAfter" }, { wordId: "w3", kind: "breakAfter" }];
    expect(buildCaptions(p).map((c) => c.lines.join(" "))).toEqual(["Hello there. Welcome to", "the course."]);
  });

  it("太長的句子拆成多段，每段最多 2 行、每行最多 42 字元", () => {
    const text = "This is a very long sentence that keeps going and going without any punctuation at all because the speaker never stops to breathe while explaining things";
    const caps = buildCaptions(projectWith(wordsOf(text)));
    expect(caps.length).toBeGreaterThan(1);
    for (const c of caps) {
      expect(c.lines.length).toBeLessThanOrEqual(2);
      for (const line of c.lines) expect(line.length).toBeLessThanOrEqual(42);
    }
    expect(caps.flatMap((c) => c.wordIds)).toHaveLength(text.split(" ").length);
  });

  it("每段最短 1 秒：太短就往後延，但不蓋到下一段", () => {
    const p = projectWith(wordsOf("Hi. Next sentence here.", { 0: 2 }));
    const caps = buildCaptions(p);
    expect(caps[0].start).toBe(0);
    expect(caps[0].end).toBe(1);
  });

  it("每段最長 7 秒：超過就拆", () => {
    // 24 個詞、每詞 0.35 秒 ≈ 8.4 秒，字數放得進兩行也要因為 7 秒上限而拆
    const text = "a b c d e f g h i j k l m n o p q r s t u v w x";
    const caps = buildCaptions(projectWith(wordsOf(text)));
    for (const c of caps) expect(c.end - c.start).toBeLessThanOrEqual(7);
  });

  it("閱讀速度超過每秒 17 字元：延長顯示到下一段開始前", () => {
    const p = projectWith(wordsOf("Supercalifragilistic expialidocious. Ok", { 1: 3 }));
    const caps = buildCaptions(p);
    const chars = caps[0].lines.join(" ").length;
    expect(chars / (caps[0].end - caps[0].start)).toBeLessThanOrEqual(17);
  });
});

describe("joinWords（中文字之間不加空白）", () => {
  it("中文、日文、全形標點相鄰不加空白；英文之間、中英交界照舊加", () => {
    expect(joinWords(["我", "們", "接下來"])).toBe("我們接下來");
    expect(joinWords(["介紹", "Spring", "MVC", "，", "好"])).toBe("介紹 Spring MVC，好");
    expect(joinWords(["Hello", "there."])).toBe("Hello there.");
    expect(joinWords(["これ", "は"])).toBe("これは");
  });

  it("字幕的每行：中文不夾空白，lineWords 留著每個詞", () => {
    let t = 0;
    const words = ["我", "們", "接", "下", "來", "介", "紹", "Spring", "MVC。"].map((w, i) => {
      const word = { id: `w${i}`, mediaId: "m1", text: w, start: t, end: t + 0.2 };
      t += 0.25;
      return word;
    });
    const [cap] = buildCaptions(projectWith(words));
    expect(cap.lines).toEqual(["我們接下來介紹 Spring MVC。"]);
    expect(cap.lineWords[0]).toEqual(["我", "們", "接", "下", "來", "介", "紹", "Spring", "MVC。"]);
  });
});
