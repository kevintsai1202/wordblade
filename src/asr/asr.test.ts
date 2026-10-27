import { describe, expect, it } from "vitest";
import { downsample, encodeWav } from "./wav";
import { splitAtSilence } from "./segment";
import { coverage, tokenize, turnsToWords, voicedSegments } from "./wordTiming";
import type { Envelope } from "../audio/envelope";

/** 由「有聲區間」組一條包絡（100 Hz；有聲 0.2、無聲 0.002） */
function env(duration: number, voiced: [number, number][]): Envelope {
  const rms = new Float32Array(Math.round(duration * 100)).fill(0.002);
  for (const [a, b] of voiced) for (let i = Math.round(a * 100); i < Math.round(b * 100); i++) rms[i] = 0.2;
  return { rate: 100, rms };
}

describe("wav", () => {
  it("編成 16-bit 單聲道 PCM WAV：檔頭、長度、樣本值（夾在 ±1）", () => {
    const bytes = encodeWav(new Float32Array([0, 0.5, -1, 2]), 16000);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(view.getUint16(22, true)).toBe(1); // 單聲道
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(tag(36)).toBe("data");
    expect(view.getUint32(40, true)).toBe(8);
    expect(bytes.length).toBe(52);
    expect(view.getInt16(46, true)).toBe(16384);
    expect(view.getInt16(48, true)).toBe(-32768);
    expect(view.getInt16(50, true)).toBe(32767);
  });

  it("降取樣：48k → 16k 每 3 個取平均；44.1k → 16k 長度照比例", () => {
    const x = Float32Array.from({ length: 9 }, (_, i) => i);
    expect(Array.from(downsample(x, 48000, 16000))).toEqual([1, 4, 7]);
    expect(downsample(new Float32Array(44100), 44100, 16000).length).toBe(16000);
    const same = new Float32Array([1, 2, 3]);
    expect(downsample(same, 16000, 16000)).toBe(same);
  });
});

describe("splitAtSilence", () => {
  it("不超過上限就一段", () => {
    expect(splitAtSilence(env(100, [[0, 100]]), 100, 180)).toEqual([{ start: 0, end: 100 }]);
  });

  it("超過上限：在上限前 30 秒內最安靜的地方切", () => {
    // 0～400 秒一直講話，只有 170.0～170.6 與 340～340.5 是無聲
    const e = env(400, [[0, 170], [170.6, 340], [340.5, 400]]);
    const parts = splitAtSilence(e, 400, 180);
    expect(parts).toHaveLength(3);
    expect(parts[0].start).toBe(0);
    expect(parts[0].end).toBeGreaterThanOrEqual(170);
    expect(parts[0].end).toBeLessThanOrEqual(170.6);
    expect(parts[1].start).toBe(parts[0].end);
    expect(parts[1].end).toBeGreaterThanOrEqual(340);
    expect(parts[1].end).toBeLessThanOrEqual(340.5);
    expect(parts[2].end).toBe(400);
    for (const p of parts) expect(p.end - p.start).toBeLessThanOrEqual(180);
  });

  it("找不到無聲處就硬切在上限", () => {
    const parts = splitAtSilence(env(200, [[0, 200]]), 200, 180);
    expect(parts.map((p) => p.end)).toEqual([180, 200]);
  });
});

describe("tokenize", () => {
  it("英文以空白分詞、標點黏在前一個詞（開頭的標點黏後一個）", () => {
    expect(tokenize("Hello, world! It's 3.5 GB.")).toEqual(["Hello,", "world!", "It's", "3.5", "GB."]);
    expect(tokenize("  \"Quoted\"  word ")).toEqual(["\"Quoted\"", "word"]);
  });

  it("中文逐字、全形標點黏前一個字；中英混合", () => {
    expect(tokenize("你好，世界。")).toEqual(["你", "好，", "世", "界。"]);
    expect(tokenize("用 Tauri 做")).toEqual(["用", "Tauri", "做"]);
    expect(tokenize("我用Tauri寫")).toEqual(["我", "用", "Tauri", "寫"]);
  });
});

describe("voicedSegments", () => {
  it("找出有聲段；短於 0.25 秒的無聲合併、太短的有聲段捨去", () => {
    const e = env(10, [[1, 2], [2.1, 3], [5, 6], [8, 8.02]]);
    const v = voicedSegments(e, 0, 10);
    expect(v).toHaveLength(2);
    expect(v[0].start).toBeCloseTo(1, 1);
    expect(v[0].end).toBeCloseTo(3, 1);
    expect(v[1].start).toBeCloseTo(5, 1);
    expect(v[1].end).toBeCloseTo(6, 1);
  });
});

describe("turnsToWords", () => {
  it("詞依字數比例分配在有聲段上，跨過停頓的詞界吸附到停頓兩側", () => {
    // 一個 turn 0～6 秒：「Hello there」在 1～2.2 秒、停頓、「general Kenobi」在 3～4.5 秒（長度比和字數比 12:15 相當）
    const e = env(6, [[1, 2.2], [3, 4.5]]);
    const words = turnsToWords("m1", [{ text: "Hello there general Kenobi", start: 0, end: 6 }], e);
    expect(words.map((w) => w.text)).toEqual(["Hello", "there", "general", "Kenobi"]);
    // 頭吸附到開口、尾吸附到收尾
    expect(words[0].start).toBeCloseTo(1, 1);
    expect(words[3].end).toBeCloseTo(4.5, 1);
    // 停頓兩側：there 收在 2.2 秒、general 從 3 秒開始
    expect(words[1].end).toBeCloseTo(2.2, 1);
    expect(words[2].start).toBeCloseTo(3, 1);
    // 依序、不重疊、id 不重複
    for (let i = 1; i < words.length; i++) expect(words[i].start).toBeGreaterThanOrEqual(words[i - 1].end - 1e-9);
    expect(new Set(words.map((w) => w.id)).size).toBe(4);
    expect(words.every((w) => w.mediaId === "m1")).toBe(true);
  });

  it("turn 裡找不到有聲段：平均分在整個 turn 上", () => {
    const words = turnsToWords("m1", [{ text: "a b", start: 2, end: 4 }], env(6, []));
    expect(words[0].start).toBeCloseTo(2);
    expect(words[1].end).toBeCloseTo(4);
  });

  it("多個 turn 依序接起來，空白 turn 略過", () => {
    const e = env(10, [[0, 2], [5, 7]]);
    const words = turnsToWords("m1", [{ text: "one two", start: 0, end: 2.5 }, { text: "  ", start: 3, end: 4 }, { text: "three", start: 4.5, end: 7.5 }], e);
    expect(words.map((w) => w.text)).toEqual(["one", "two", "three"]);
    expect(words[2].start).toBeCloseTo(5, 1);
  });
});

describe("coverage", () => {
  it("turns 涵蓋的有聲時間比例（偵測漏段）", () => {
    const e = env(100, [[0, 50], [60, 100]]);
    expect(coverage([{ text: "x", start: 0, end: 50 }], e, 0, 100)).toBeCloseTo(50 / 90, 2);
    expect(coverage([{ text: "x", start: 0, end: 100 }], e, 0, 100)).toBeCloseTo(1, 2);
  });
});
