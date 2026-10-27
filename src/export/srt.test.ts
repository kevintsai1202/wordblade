import { describe, expect, it } from "vitest";
import { srtTime, toSrt } from "./srt";

describe("srt", () => {
  it("時間格式 HH:MM:SS,mmm（毫秒四捨五入）", () => {
    expect(srtTime(0)).toBe("00:00:00,000");
    expect(srtTime(3723.4567)).toBe("01:02:03,457");
    expect(srtTime(59.9996)).toBe("00:01:00,000");
  });

  it("每段編號、起訖、各行文字，段落之間空一行（CRLF）", () => {
    const text = toSrt([
      { id: "a", start: 1, end: 2.5, lines: ["Hello there,", "world"], wordIds: [] },
      { id: "b", start: 3, end: 4, lines: ["Again"], wordIds: [] },
    ]);
    expect(text).toBe("1\r\n00:00:01,000 --> 00:00:02,500\r\nHello there,\r\nworld\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\nAgain\r\n");
  });

  it("沒有字幕回空字串", () => {
    expect(toSrt([])).toBe("");
  });
});
