import { describe, expect, it } from "vitest";
import { addMedia, emptyProject } from "../core/media";
import type { Project } from "../core/model";
import { placeMedia } from "../core/timeline";
import { addVoiceover, setVoiceoverActive } from "../core/voiceover";
import { duckingCurve, gainAt } from "./ducking";
import { ENVELOPE_RATE, EnvelopeBuilder, type Envelope } from "./envelope";

/** 做一份 duration 秒的包絡：[loudFrom, loudTo) 之間音量 0.3，其餘 0.001 */
function envelope(duration: number, loudFrom: number, loudTo: number): Envelope {
  const rms = new Float32Array(Math.round(duration * ENVELOPE_RATE));
  rms.forEach((_, i) => { rms[i] = i / ENVELOPE_RATE >= loudFrom && i / ENVELOPE_RATE < loudTo ? 0.3 : 0.001; });
  return { rate: ENVELOPE_RATE, rms };
}

/** 對白影片 talk（20 秒）放 V1／A1，配樂 mus 放 A2 */
function project(): Project {
  let p = addMedia(emptyProject(), [
    { id: "talk", kind: "video", duration: 20, fps: 30, audio: true },
    { id: "mus", kind: "audio", duration: 60 },
  ]);
  p = placeMedia(p, "talk", "V1", 0);
  return placeMedia(p, "mus", "A2", 0);
}

describe("EnvelopeBuilder", () => {
  it("每 10 ms 一個 RMS；跨 push 的資料接得起來", () => {
    const b = new EnvelopeBuilder(1000); // 每格 10 個樣本
    b.push(new Float32Array(15).fill(0.5));
    b.push(new Float32Array(10).fill(0));
    const env = b.finish();
    expect(env.rate).toBe(100);
    expect(Array.from(env.rms).map((v) => Math.round(v * 1000) / 1000)).toEqual([0.5, 0.354, 0]);
  });
});

describe("duckingCurve（配樂壓低，預覽與匯出共用）", () => {
  it("對白在 2～4 秒：中間壓到 depth，之前與遠在之後是 1", () => {
    const curve = duckingCurve(project(), new Map([["talk", envelope(20, 2, 4)]]));
    expect(gainAt(curve, 1)).toBe(1);
    expect(gainAt(curve, 3.5)).toBeCloseTo(0.3, 2);
    expect(gainAt(curve, 9)).toBeCloseTo(1, 2);
  });

  it("依片段換算素材時間：片段從素材 10 秒開始，素材 12～13 秒有聲音 → 時間軸 2～3 秒壓低", () => {
    let p = addMedia(emptyProject(), [{ id: "talk", kind: "video", duration: 20, audio: true }, { id: "mus", kind: "audio", duration: 60 }]);
    p = placeMedia(placeMedia(p, "talk", "V1", 0), "mus", "A2", 0);
    p = { ...p, clips: p.clips.map((c) => (c.mediaId === "talk" ? { ...c, srcIn: 10 } : c)) };
    const curve = duckingCurve(p, new Map([["talk", envelope(20, 12, 13)]]));
    expect(gainAt(curve, 2.9)).toBeLessThan(0.4);
    expect(gainAt(curve, 0.5)).toBe(1);
  });

  it("對白軌靜音、沒有包絡、音量低於門檻：都不壓", () => {
    const p = project();
    const muted = { ...p, tracks: p.tracks.map((t) => (t.id === "A1" ? { ...t, muted: true } : t)) };
    expect(gainAt(duckingCurve(muted, new Map([["talk", envelope(20, 2, 4)]])), 3)).toBe(1);
    expect(gainAt(duckingCurve(p, new Map()), 3)).toBe(1);
    expect(gainAt(duckingCurve(p, new Map([["talk", envelope(20, 0, 0)]])), 3)).toBe(1);
  });

  it("超出曲線範圍的時間回 1", () => {
    const curve = duckingCurve(project(), new Map([["talk", envelope(20, 0, 20)]]));
    expect(gainAt(curve, -1)).toBe(1);
    expect(gainAt(curve, 999)).toBe(1);
  });
});

// AI 重配音（2026-11-02）：生效中的 AI 聲音也算「有人講話」，配樂要壓低；切回原聲時 AI 片段靜音，不算
describe("duckingCurve 與 AI 重配音", () => {
  it("對白素材在 10～14 秒沒聲音，AI 聲音放在 10 秒：生效時壓低、切回原聲時不壓", () => {
    let p = addMedia(project(), [{ id: "ai", kind: "audio", duration: 3, audio: true }]);
    p = addVoiceover(p, { id: "v", start: 10, end: 14, text: "hi", mediaId: "ai" });
    const env = new Map([["talk", envelope(20, 2, 4)], ["ai", envelope(3, 0, 3)]]);
    expect(gainAt(duckingCurve(p, env), 11.5)).toBeCloseTo(0.3, 2);
    expect(gainAt(duckingCurve(setVoiceoverActive(p, "v", false), env), 11.5)).toBe(1);
  });
});
