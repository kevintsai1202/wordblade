import { describe, expect, it } from "vitest";
import type { Envelope } from "../audio/envelope";
import type { Media } from "../core/model";
import { transcribeMedia, type AsrResponse } from "./transcribe";

/** 由有聲區間組包絡 */
function env(duration: number, voiced: [number, number][]): Envelope {
  const rms = new Float32Array(Math.round(duration * 100)).fill(0.002);
  for (const [a, b] of voiced) for (let i = Math.round(a * 100); i < Math.round(b * 100); i++) rms[i] = 0.2;
  return { rate: 100, rms };
}

const media: Media = { id: "m1", kind: "video", duration: 400, audio: true };

describe("transcribeMedia", () => {
  it("在無聲處切段、各段平行送出、turn 時間加上段的起點、詞依序接起來", async () => {
    // 有聲 0～170、170.6～340、340.5～400；切成三段
    const e = env(400, [[0, 170], [170.6, 340], [340.5, 400]]);
    const asked: [number, number][] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const extract = async (_m: Media, s: number, t: number) => {
      asked.push([s, t]);
      return new Uint8Array([s]);
    };
    const send = async (wav: Uint8Array): Promise<AsrResponse> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { transcript: `part ${wav[0]}`, audioDurationMs: 0, turns: [{ transcript: `part ${wav[0]}`, startMs: 1000, endMs: 3000, speaker: "0" }] };
    };
    const progress: number[] = [];
    const result = await transcribeMedia(media, e, extract, send, (p) => progress.push(p.done), { parallel: 2 });
    expect(asked).toHaveLength(3);
    expect(maxInFlight).toBeLessThanOrEqual(2);
    expect(result.segments).toBe(3);
    // 第二段從 170.x 秒開始：它的 turn 在 171～173 秒
    const second = result.words.filter((w) => w.text === "part" || /^\d/.test(w.text));
    expect(second.length).toBe(6);
    expect(result.words[2].start).toBeGreaterThan(171);
    expect(result.words[2].start).toBeLessThan(174);
    // 依時間排序、id 不重複
    for (let i = 1; i < result.words.length; i++) expect(result.words[i].start).toBeGreaterThanOrEqual(result.words[i - 1].start);
    expect(new Set(result.words.map((w) => w.id)).size).toBe(result.words.length);
    expect(progress[progress.length - 1]).toBe(3);
  });

  it("turns 是空的但有整段文字：整段當一個 turn；涵蓋率低時回報", async () => {
    const e = env(20, [[2, 18]]);
    const result = await transcribeMedia({ ...media, duration: 20 }, e, async () => new Uint8Array(1), async () => ({ transcript: "hello world", turns: [], audioDurationMs: 20000 }), () => undefined);
    expect(result.words.map((w) => w.text)).toEqual(["hello", "world"]);
    expect(result.words[0].start).toBeCloseTo(2, 1);
    // 只靠整段文字（沒有 turn 時間）：涵蓋率算 1（整段都是同一個 turn）
    expect(result.coverage).toBeCloseTo(1, 1);
  });

  it("閘道忙（503）重試，最多三次", async () => {
    const e = env(10, [[1, 9]]);
    let calls = 0;
    const send = async (): Promise<AsrResponse> => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("busy"), { status: 503 });
      return { transcript: "ok", turns: [{ transcript: "ok", startMs: 1000, endMs: 9000, speaker: null }], audioDurationMs: 10000 };
    };
    const result = await transcribeMedia({ ...media, duration: 10 }, e, async () => new Uint8Array(1), send, () => undefined, { retryDelayMs: 1 });
    expect(calls).toBe(3);
    expect(result.words).toHaveLength(1);
  });

  it("其他錯誤直接往外拋", async () => {
    const e = env(10, [[1, 9]]);
    await expect(transcribeMedia({ ...media, duration: 10 }, e, async () => new Uint8Array(1), async () => { throw Object.assign(new Error("bad"), { status: 400 }); }, () => undefined)).rejects.toThrow("bad");
  });
});
