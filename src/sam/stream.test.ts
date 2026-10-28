import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeMask } from "./decoder";
import { SamStream, parseSam, sseDeltas, type SamRecord } from "./stream";

// SAM 3.1 逐格輸出的解析（照搬 transcript-review face_track.SamStream 的測試）：一格一行 <N f>id<|box;…|><|mask;…|>，
// 遮罩內容可能含 < > |，結尾只認後面接逗號、換行或文字結束的「|>」；任意位置切開結果相同。
const TEXT = "<0f>0<|box;x1=10;y1=20;x2=50;y2=70;w=640;h=360|><|mask;x=0;y=0;data=50,40,~a|><1f>c|>,"
  + "1<|box;x1=100;y1=20;x2=140;y2=60;w=640;h=360|><|mask;x=0;y=0;data=40,40,!xyz|>\n"
  + "<2f>0<|box;x1=12;y1=21;x2=52;y2=71;w=640;h=360|><|mask;x=0;y=0;data=2,2,!|>|>\r\n"
  + "<4f>7<|box;x1=5;y1=6;x2=7;y2=8;w=640;h=360|>\n"
  + "<5f>3<|box;x1=1;y1=2;x2=3;y2=4;w=640;h=360|><|mask;x=0;y=0;data=2,2,~q<|>";

/** 記錄 → 比較用的簡寫 */
const brief = (frames: { frame: number; records: SamRecord[] }[]) =>
  frames.map((f) => [f.frame, f.records.map((r) => [r.id, r.x1, r.y1, r.x2, r.y2, r.w, r.h, r.mask && [r.mask.x, r.mask.y, r.mask.h, r.mask.w, r.mask.payload]])]);

const EXPECTED = [
  [0, [[0, 10, 20, 50, 70, 640, 360, [0, 0, 50, 40, "~a|><1f>c"]], [1, 100, 20, 140, 60, 640, 360, [0, 0, 40, 40, "!xyz"]]]],
  [2, [[0, 12, 21, 52, 71, 640, 360, [0, 0, 2, 2, "!|>"]]]],
  [4, [[7, 5, 6, 7, 8, 640, 360, null]]],
  [5, [[3, 1, 2, 3, 4, 640, 360, [0, 0, 2, 2, "~q<"]]]],
];

describe("SamStream", () => {
  it("整段解析：遮罩內容裡的「|>」不會切錯；沒有遮罩的記錄是 null", () => {
    expect(brief(parseSam(TEXT))).toEqual(EXPECTED);
  });

  it("任意位置切開結果相同", () => {
    for (let cut = 1; cut < TEXT.length; cut++) {
      const s = new SamStream();
      expect(brief([...s.feed(TEXT.slice(0, cut)), ...s.feed(TEXT.slice(cut)), ...s.close()]), `cut ${cut}`).toEqual(EXPECTED);
    }
  });

  it("欄位依名稱讀（c= 略過）；沒有 data 或亂碼丟錯", () => {
    const got = parseSam("<6f>2<|box;x1=1;y1=2;x2=3;y2=4;w=640;h=360;c=0.8|><|mask;c=0.9;x=1;y=2;data=3,4,!a=b|>\n");
    expect(brief(got)).toEqual([[6, [[2, 1, 2, 3, 4, 640, 360, [1, 2, 3, 4, "!a=b"]]]]]);
    expect(() => parseSam("<0f>0<|box;x1=1;y1=2;x2=3;y2=4;w=9;h=9|><|mask;x=0;y=0|>\n")).toThrow();
    expect(() => parseSam("抱歉，我無法處理這段影片。")).toThrow();
  });

  it("換行一到這一格就完整", () => {
    const s = new SamStream();
    expect(brief(s.feed("<0f>0<|box;x1=272;y1=252;x2=486;y2=498;w=1280;h=720|><|mask;x=0;y=0;data=247,215,!!!!#oBHh$Gul{$W^NP.BMa^Y|>\n"))).toEqual([[0, [[0, 272, 252, 486, 498, 1280, 720, [0, 0, 247, 215, "!!!!#oBHh$Gul{$W^NP.BMa^Y"]]]]]);
  });
});

describe("2026-10-28 實測串流（scripts/sam/probe.mjs：FOSDEM 講者、person、40 格、1280 寬）", () => {
  const raw = readFileSync(path.join(import.meta.dirname, "fixtures", "fosdem-person.sse"), "utf8");
  it("SSE 的 delta 串起來解析出 40 格，每個遮罩都解得開、尺寸 = 框 + 1", () => {
    const frames = parseSam(sseDeltas(raw).join(""));
    expect(frames).toHaveLength(40);
    expect(frames.map((f) => f.frame)).toEqual(Array.from({ length: 40 }, (_, i) => i));
    for (const { records } of frames) {
      for (const r of records) {
        expect(r.mask).not.toBeNull();
        expect(r.mask!.h).toBe(r.y2 - r.y1 + 1);
        expect(r.mask!.w).toBe(r.x2 - r.x1 + 1);
        const raster = decodeMask(r.mask!.payload, r.mask!.w, r.mask!.h);
        expect(raster.reduce((a, b) => a + b, 0)).toBeGreaterThan(r.mask!.w * r.mask!.h * 0.2);
      }
    }
  });
});
