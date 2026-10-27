import { describe, expect, it } from "vitest";
import type { Envelope } from "../audio/envelope";
import raw from "./fixtures/demo-turns.json";
import truth from "./fixtures/demo-truth.json";
import envelope from "./fixtures/demo-envelope.json";
import deltaFixture from "./fixtures/demo-deltas.json";
import { deltasToWords, turnsToWords, voicedSegments } from "./wordTiming";

// 回歸測試（真實資料）：Muse 對模擬 D30 短片（scripts/demo-sample）每段 60 秒的回應——有疊字（takes takes）、吞掉 uh。
// 2026-10-27 實測：誤差主要跟 turn 長度有關（每段 180 秒時一個 turn 85 秒、句首提早 1.5～2.3 秒；60 秒時平均 0.19 秒），
// 所以預設每段 60 秒（transcribe.ts）。音量包絡是那支片真正的包絡（句內逗號的停頓也在；只用句子起訖合成的包絡沒有這些停頓，對不準），
// 檢查每句第一個詞的起點對不對得上。

/** 真正的音量包絡 */
function realEnvelope(): Envelope {
  return { rate: envelope.rate, rms: Float32Array.from(envelope.rms) };
}

/** 比對用：小寫、去標點 */
const bare = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

describe("詞級時間：真實 Muse 回應（長 turn、無標點）", () => {
  it("每句第一個詞的起點：平均誤差 < 0.3 秒、七成以上在 0.3 秒內、最大 < 1.2 秒", () => {
    const turns = raw.turns;
    const words = turnsToWords("demo", turns, realEnvelope());
    const errors: { sentence: string; error: number }[] = [];
    for (const s of truth.sentences) {
      const first = bare(s.text.split(/\s+/)[0]);
      // 同一個字、起點最接近句子起點的那個詞
      const cand = words.filter((w) => bare(w.text) === first).sort((a, b) => Math.abs(a.start - s.start) - Math.abs(b.start - s.start))[0];
      if (cand && Math.abs(cand.start - s.start) < 5) errors.push({ sentence: s.text.slice(0, 30), error: Number((cand.start - s.start).toFixed(2)) });
    }
    const abs = errors.map((e) => Math.abs(e.error));
    const detail = JSON.stringify(errors);
    expect(errors.length).toBeGreaterThan(truth.sentences.length * 0.8);
    expect(abs.reduce((a, b) => a + b, 0) / abs.length, detail).toBeLessThan(0.3);
    expect(abs.filter((x) => x <= 0.3).length / abs.length, detail).toBeGreaterThanOrEqual(0.7);
    expect(Math.max(...abs), detail).toBeLessThan(1.2);
  });
});

describe("詞級時間：DELTA 錨點（真實 Muse 串流＋真實包絡）", () => {
  it("句首平均誤差 ≤ 0.15 秒、八成五以上在 0.3 秒內；每個字在有聲段內、依序、長度合理、字數和整段文字一致", () => {
    const deltas = deltaFixture.deltas.map((d) => ({ text: d.text, t: d.ms / 1000 }));
    const env = realEnvelope();
    const words = deltasToWords("demo", deltas, env);
    // 字數：DELTA 的字和 speechComplete 的整段文字一樣多
    const fullCount = deltaFixture.turns.reduce((n, t) => n + t.transcript.split(/\s+/).filter(Boolean).length, 0);
    expect(Math.abs(words.length - fullCount)).toBeLessThanOrEqual(3);
    // 句首
    const errors: { sentence: string; error: number }[] = [];
    for (const s of truth.sentences) {
      const first = bare(s.text.split(/\s+/)[0]);
      const cand = words.filter((w) => bare(w.text) === first).sort((a, b) => Math.abs(a.start - s.start) - Math.abs(b.start - s.start))[0];
      if (cand && Math.abs(cand.start - s.start) < 5) errors.push({ sentence: s.text.slice(0, 30), error: Number((cand.start - s.start).toFixed(2)) });
    }
    const abs = errors.map((e) => Math.abs(e.error));
    const detail = JSON.stringify(errors);
    expect(errors.length).toBe(truth.sentences.length);
    expect(abs.reduce((a, b) => a + b, 0) / abs.length, detail).toBeLessThanOrEqual(0.15);
    expect(abs.filter((x) => x <= 0.3).length / abs.length, detail).toBeGreaterThanOrEqual(0.85);
    // 內部合理性：每個字的起點在有聲段內、嚴格遞增、長度 0.05～1.5 秒
    const voiced = voicedSegments(env, 0, truth.duration);
    for (const [i, w] of words.entries()) {
      expect(voiced.some((v) => w.start >= v.start - 0.05 && w.start <= v.end + 0.05), `${w.text}@${w.start}`).toBe(true);
      expect(w.end - w.start, `${w.text}@${w.start}`).toBeGreaterThanOrEqual(0.05);
      expect(w.end - w.start, `${w.text}@${w.start}`).toBeLessThanOrEqual(1.5);
      if (i) expect(w.start, `${w.text}@${w.start}`).toBeGreaterThan(words[i - 1].start);
    }
  });
});
