// 宣告式音訊解讀器的實際算圖：Node 沒有 Web Audio，測試用 node-web-audio-api 的 OfflineAudioContext（和瀏覽器同一套 API）。
import { OfflineAudioContext as NodeOfflineAudioContext } from "node-web-audio-api";
import { describe, expect, it } from "vitest";
import { SYNTH_RATE, renderMusic, renderSound, synthToWav, type ContextFactory } from "./render";
import { musicFrames, type MusicSpec, type SoundSpec } from "./spec";
import { MUSIC_EXAMPLES, SOUND_TEMPLATES } from "./templates";

/** 測試用的 OfflineAudioContext 工廠 */
const factory: ContextFactory = (channels, length, rate) => new NodeOfflineAudioContext(channels, length, rate) as unknown as OfflineAudioContext;

/** 最大絕對值 */
function peak(x: Float32Array): number {
  let m = 0;
  for (const v of x) m = Math.max(m, Math.abs(v));
  return m;
}

/** 相鄰樣本最大的跳動（from～to 之間） */
function maxJump(x: Float32Array, from = 1, to = x.length): number {
  let m = 0;
  for (let i = Math.max(1, from); i < to; i++) m = Math.max(m, Math.abs(x[i] - x[i - 1]));
  return m;
}

/** 一段 RMS */
function rms(x: Float32Array, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / (to - from));
}

describe("renderSound", () => {
  it("長度剛好是 length 秒的樣本數；有聲音、不超過 0.9", async () => {
    const spec: SoundSpec = { length: 0.37, voices: [{ source: { type: "osc", wave: "sawtooth", freq: [{ t: 0, v: 200 }, { t: 0.3, v: 1200 }] }, filter: { type: "lowpass", cutoff: 3000 }, env: { attack: 0.01, decay: 0.05, sustain: 0.7, release: 0.05 } }] };
    const x = await renderSound(spec, factory);
    expect(x.length).toBe(Math.round(0.37 * SYNTH_RATE));
    expect(peak(x)).toBeGreaterThan(0.05);
    expect(peak(x)).toBeLessThanOrEqual(0.9);
    // 結尾淡出：最後一個樣本接近 0（不會喀一聲）
    expect(Math.abs(x[x.length - 1])).toBeLessThan(0.01);
  });

  it("每個內建範本都算得出聲音", async () => {
    for (const t of SOUND_TEMPLATES) {
      const x = await renderSound(t.spec, factory);
      expect(x.length, t.id).toBe(Math.round(t.spec.length * SYNTH_RATE));
      expect(peak(x), t.id).toBeGreaterThan(0.02);
    }
  });

  it("同一份 spec 算兩次結果完全一樣（雜訊與殘響用固定種子）", async () => {
    const whoosh = SOUND_TEMPLATES.find((t) => t.id === "whoosh")!.spec;
    const a = await renderSound(whoosh, factory);
    const b = await renderSound(whoosh, factory);
    expect(Buffer.from(synthToWav(a)).equals(Buffer.from(synthToWav(b)))).toBe(true);
    // 換種子就不一樣
    const c = await renderSound({ ...whoosh, seed: 999 }, factory);
    expect(Buffer.from(synthToWav(a)).equals(Buffer.from(synthToWav(c)))).toBe(false);
  });
});

describe("renderMusic", () => {
  /** 一小節 2 秒；最後一拍起一個長音跨過結尾（加上 release），檢查接縫 */
  const SEAM: MusicSpec = {
    bpm: 120, bars: 1, chords: ["A"],
    parts: [{ role: "pad", voice: { source: { type: "osc", wave: "sine" }, env: { attack: 0.01, decay: 0, sustain: 1, release: 0.4 } }, notes: [{ at: 3, len: 2, pitch: 57 }] }],
  };

  it("長度剛好是整數小節", async () => {
    for (const t of MUSIC_EXAMPLES) {
      const x = await renderMusic(t.spec, factory);
      expect(x.length, t.id).toBe(musicFrames(t.spec, SYNTH_RATE));
      expect(peak(x), t.id).toBeGreaterThan(0.05);
      expect(peak(x), t.id).toBeLessThanOrEqual(0.9);
    }
  });

  it("首尾無縫：跨過結尾的音折回開頭，接縫的跳動不比中間大", async () => {
    const x = await renderMusic(SEAM, factory);
    expect(x.length).toBe(96000);
    // 開頭有聲音（是上一圈延續過來的那個音）
    expect(rms(x, 0, 2400)).toBeGreaterThan(0.05);
    // 接縫（最後一個樣本 → 第一個樣本）的跳動和音符中段差不多
    const seam = Math.abs(x[0] - x[x.length - 1]);
    const interior = maxJump(x, 80000, 95000);
    expect(seam).toBeLessThanOrEqual(interior * 1.5);
  });

  it("同一份 spec 算兩次結果完全一樣", async () => {
    const spec = MUSIC_EXAMPLES[0].spec;
    const a = synthToWav(await renderMusic(spec, factory));
    const b = synthToWav(await renderMusic(spec, factory));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });
});

describe("synthToWav", () => {
  it("48 kHz 單聲道 16-bit WAV", () => {
    const wav = synthToWav(new Float32Array(480));
    const view = new DataView(wav.buffer);
    expect(String.fromCharCode(...wav.slice(0, 4))).toBe("RIFF");
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(22, true)).toBe(1);
    expect(wav.length).toBe(44 + 960);
  });
});

describe("隨機振幅調變 am（翻頁的紙張顆粒感，§5.23）", () => {
  /** 0.5 秒的正弦長音；am 有給就加上 */
  const tone = (am?: { rate: number; depth: number }): SoundSpec => ({
    length: 0.5, voices: [{ source: { type: "osc", wave: "sine", freq: 440 }, env: { attack: 0.005, decay: 0, sustain: 1, release: 0.01 }, ...(am ? { am } : {}) }],
  });
  /** 中段每 10 ms 一格的 RMS，最大÷最小 */
  const spread = (x: Float32Array) => {
    const step = SYNTH_RATE / 100;
    const values: number[] = [];
    for (let i = step * 5; i + step < x.length - step * 5; i += step) values.push(rms(x, i, i + step));
    return Math.max(...values) / Math.max(1e-6, Math.min(...values));
  };

  it("沒有 am 的長音包絡平穩；加了 am 起伏明顯，同一份 spec 結果相同", async () => {
    expect(spread(await renderSound(tone(), factory))).toBeLessThan(1.2);
    const a = await renderSound(tone({ rate: 60, depth: 0.85 }), factory);
    expect(spread(a)).toBeGreaterThan(2);
    const b = await renderSound(tone({ rate: 60, depth: 0.85 }), factory);
    expect(Buffer.from(synthToWav(a)).equals(Buffer.from(synthToWav(b)))).toBe(true);
  });
});
