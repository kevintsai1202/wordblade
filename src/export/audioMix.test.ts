import { describe, expect, it } from "vitest";
import { makeClip, makeProject } from "../core/fixtures";
import { addVoiceover, setVoiceoverActive } from "../core/voiceover";
import { mixExtra, mixSpan, resampleLinear, stretch, voicesIn } from "./audioMix";

/** 正弦波 */
function sine(freq: number, rate: number, seconds: number): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * freq * i) / rate);
  return out;
}

/** 上升穿越零點的次數（估頻率） */
function zeroCrossings(x: Float32Array, from = 0, to = x.length): number {
  let n = 0;
  for (let i = from + 1; i < to; i++) if (x[i - 1] < 0 && x[i] >= 0) n++;
  return n;
}

describe("resampleLinear", () => {
  it("44.1k → 48k：長度照指定、頻率不變", () => {
    const x = sine(440, 44100, 1);
    const y = resampleLinear(x, 44100, 48000);
    expect(y.length).toBe(48000);
    expect(zeroCrossings(y)).toBeGreaterThanOrEqual(439);
    expect(zeroCrossings(y)).toBeLessThanOrEqual(441);
  });

  it("同取樣率直接回傳同內容", () => {
    const x = sine(100, 48000, 0.1);
    expect(Array.from(resampleLinear(x, 48000, x.length))).toEqual(Array.from(x));
  });
});

describe("stretch（WSOLA，保持音高）", () => {
  it("2 倍速：長度減半、音高不變", () => {
    const x = sine(500, 48000, 2);
    const [left, right] = stretch([x, x], 2, 48000);
    expect(left.length).toBe(48000);
    expect(right.length).toBe(48000);
    // 中段（避開頭尾暫態）每秒穿越零點仍約 500 次
    const mid = zeroCrossings(left, 12000, 36000) / 0.5;
    expect(mid).toBeGreaterThan(470);
    expect(mid).toBeLessThan(530);
  });

  it("0.5 倍速：長度加倍", () => {
    const x = sine(300, 48000, 1);
    const [left] = stretch([x, x], 0.5, 96000);
    expect(left.length).toBe(96000);
    const mid = zeroCrossings(left, 24000, 72000) / 1;
    expect(mid).toBeGreaterThan(280);
    expect(mid).toBeLessThan(320);
  });
});

describe("voicesIn", () => {
  it("和 [a, b) 重疊的音訊片段：交集的時間軸範圍與起點的素材時間；影像軌與靜音軌不算", () => {
    const p = makeProject();
    const spans = voicesIn(p, 5, 15);
    expect(spans.map((s) => s.clipId).sort()).toEqual(["a1a", "a1b", "a2"]);
    const a1b = spans.find((s) => s.clipId === "a1b")!;
    expect(a1b).toMatchObject({ mediaId: "m1", from: 10, to: 15, srcFrom: 20, speed: 1, music: false });
    expect(spans.find((s) => s.clipId === "a2")!.music).toBe(true);
    p.tracks = p.tracks.map((t) => (t.id === "A2" ? { ...t, muted: true } : t));
    expect(voicesIn(p, 5, 15).some((s) => s.clipId === "a2")).toBe(false);
  });

  it("變速片段：素材時間照速度換算", () => {
    const p = makeProject();
    p.clips.push(makeClip({ id: "fast", mediaId: "mus", trackId: "A2", srcIn: 0, srcOut: 20, start: 40, speed: 2 }));
    const span = voicesIn(p, 42, 100).find((s) => s.clipId === "fast")!;
    expect(span).toMatchObject({ from: 42, to: 50, srcFrom: 4, speed: 2 });
  });
});

describe("mixSpan", () => {
  it("疊進輸出：片段音量×軌道音量×淡入淡出，配樂再乘壓低曲線", () => {
    const p = makeProject();
    p.clips = p.clips.map((c) => (c.id === "a2" ? { ...c, volume: 0.5, fadeIn: 1 } : c));
    p.tracks = p.tracks.map((t) => (t.id === "A2" ? { ...t, volume: 0.8 } : t));
    const rate = 100;
    const out: [Float32Array, Float32Array] = [new Float32Array(300), new Float32Array(300)];
    const ones = new Float32Array(200).fill(1);
    // a2 從 0 秒開始；輸出區塊從 0 秒開始，span 0～2 秒
    const span = voicesIn(p, 0, 2).find((s) => s.clipId === "a2")!;
    const duck = { rate: 100, gain: new Float32Array(300).fill(0.5) };
    mixSpan(out, 0, rate, p, span, [ones, ones], duck);
    // 0.5 秒：淡入一半 → 0.5 × 0.8 × 0.5 × 壓低 0.5 = 0.1
    expect(out[0][50]).toBeCloseTo(0.1, 2);
    // 1.5 秒：淡入結束 → 0.2
    expect(out[1][150]).toBeCloseTo(0.2, 2);
    // span 之外不動
    expect(out[0][250]).toBe(0);
  });

  it("對白不受壓低影響；疊加是相加", () => {
    const p = makeProject();
    const out: [Float32Array, Float32Array] = [new Float32Array(100).fill(0.25), new Float32Array(100)];
    const span = voicesIn(p, 0, 1).find((s) => s.clipId === "a1a")!;
    const half = new Float32Array(100).fill(0.5);
    mixSpan(out, 0, 100, p, span, [half, half], { rate: 100, gain: new Float32Array(100).fill(0.1) });
    expect(out[0][10]).toBeCloseTo(0.75);
    expect(out[1][10]).toBeCloseTo(0.5);
  });

  it("輸出區塊不從 0 開始時，span 的位置相對區塊起點", () => {
    const p = makeProject();
    const out: [Float32Array, Float32Array] = [new Float32Array(100), new Float32Array(100)];
    const span = voicesIn(p, 10, 11).find((s) => s.clipId === "a1b")!;
    const ones = new Float32Array(100).fill(1);
    mixSpan(out, 10, 100, p, span, [ones, ones], null);
    expect(out[0][0]).toBeCloseTo(1);
    expect(out[0][99]).toBeCloseTo(1);
  });
});

describe("特效音效疊進輸出區塊（mixExtra）", () => {
  it("從時間軸 t 秒開始疊上；跨區塊時只疊區塊裡的那段", () => {
    const rate = 10;
    const extra = { t: 1.5, channels: [new Float32Array([1, 1, 1, 1, 1]), new Float32Array([2, 2, 2, 2, 2])] as [Float32Array, Float32Array] };
    // 區塊 0～2 秒：1.5～2 秒疊前 5 格中的 5 格
    const a: [Float32Array, Float32Array] = [new Float32Array(20), new Float32Array(20)];
    mixExtra(a, 0, rate, extra);
    expect(Array.from(a[0].subarray(14, 20))).toEqual([0, 1, 1, 1, 1, 1]);
    expect(a[1][19]).toBe(2);
    // 區塊 1.7～2.7 秒：從音效第 2 格開始
    const b: [Float32Array, Float32Array] = [new Float32Array(10), new Float32Array(10)];
    mixExtra(b, 1.7, rate, extra);
    expect(Array.from(b[0].subarray(0, 4))).toEqual([1, 1, 1, 0]);
  });
});

describe("mixSpan 與重配音（§5.6）", () => {
  /** 對白 a1a（0～10 秒）餵全 1 的聲音混 0～10 秒，rate 1000 */
  const mixDialogue = (active: boolean) => {
    let p = makeProject();
    p.media.push({ id: "vo1", kind: "audio", duration: 3 });
    p = addVoiceover(p, { id: "vo-a", start: 4, end: 7, text: "x", mediaId: "vo1" });
    if (!active) p = setVoiceoverActive(p, "vo-a", false);
    const out: [Float32Array, Float32Array] = [new Float32Array(10000), new Float32Array(10000)];
    const ones = new Float32Array(10000).fill(1);
    mixSpan(out, 0, 1000, p, voicesIn(p, 0, 10).find((s) => s.clipId === "a1a")!, [ones, ones], null);
    return out[0];
  };

  it("生效：範圍內零、邊緣 10 ms 淡出入、範圍外原樣", () => {
    const x = mixDialogue(true);
    expect(x[3000]).toBe(1);
    expect(x[3995]).toBeCloseTo(0.5, 1); // 範圍開始前 5 ms
    expect(x[4000]).toBe(0);
    expect(x[5500]).toBe(0);
    expect(x[6999]).toBe(0);
    expect(x[7005]).toBeCloseTo(0.5, 1); // 範圍結束後 5 ms
    expect(x[7500]).toBe(1);
  });

  it("切回原音：對白完整", () => {
    expect(mixDialogue(false).every((v) => v === 1)).toBe(true);
  });
});
