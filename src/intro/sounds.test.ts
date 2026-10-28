import { OfflineAudioContext as NodeOfflineAudioContext } from "node-web-audio-api";
import { describe, expect, it } from "vitest";
import { renderMusic, renderSound, type ContextFactory } from "../audio/synth/render";
import { musicFrames, validateMusic, validateSound } from "../audio/synth/spec";
import { flipIntro } from "./flip";
import { INTRO_MUSIC, INTRO_MUSIC_REVEAL, introSoundCues, introSoundSpecs } from "./sounds";

// 翻頁式片頭的聲音（spec §5.23、調查 §1.6、§3.4）：翻頁（慢／快兩版）、上升音、重擊，和內建配樂；時間都從 cue 表來。
const images = Array.from({ length: 16 }, (_, i) => `img${i}`);

describe("introSoundSpecs：音效 spec", () => {
  it("每一種都通過驗證；翻頁有隨機振幅調變（紙張顆粒感）", () => {
    const plan = flipIntro({ imageIds: images, title: "x", fps: 30, seed: 1 });
    const specs = introSoundSpecs(plan);
    expect(Object.keys(specs).sort()).toEqual(["flipFast", "flipSlow", "impact", "riser"]);
    for (const [key, spec] of Object.entries(specs)) expect(validateSound(spec).ok, key).toBe(true);
    expect(specs.flipSlow.length).toBeCloseTo(0.32, 6);
    expect(specs.flipFast.length).toBeCloseTo(0.12, 6);
    expect(specs.flipSlow.voices.some((v) => v.am)).toBe(true);
    // 上升音蓋住 riserStart 到 climax（再多 0.2 秒）
    expect(specs.riser.length).toBeCloseTo(2.2, 6);
  });
});

describe("introSoundCues：音效擺位", () => {
  it("每頁一聲（間隔 > 0.13 秒用慢版、之後快版且較小聲）、上升音在 riserStart、重擊在揭曉", () => {
    const plan = flipIntro({ imageIds: images, title: "x", fps: 30, seed: 1 });
    const cues = introSoundCues(plan);
    const pages = plan.cues.filter((c) => c.kind === "page");
    const flips = cues.filter((c) => c.key === "flipSlow" || c.key === "flipFast");
    expect(flips.map((c) => c.t)).toEqual(pages.map((p) => p.t));
    expect(flips[0]).toMatchObject({ key: "flipSlow", volume: 1 });
    expect(flips[flips.length - 1].key).toBe("flipFast");
    expect(flips[flips.length - 1].volume).toBeLessThan(0.5);
    expect(cues.find((c) => c.key === "riser")!.t).toBeCloseTo(plan.cues.find((c) => c.kind === "riserStart")!.t, 6);
    expect(cues.find((c) => c.key === "impact")!.t).toBe(plan.reveal);
  });
});

describe("INTRO_MUSIC：內建配樂", () => {
  it("通過驗證；120 BPM 4 小節＝8 秒；重拍（鼓與貝斯進場）在第 3 小節＝4 秒", () => {
    expect(validateMusic(INTRO_MUSIC).ok).toBe(true);
    expect(musicFrames(INTRO_MUSIC, 48000)).toBe(8 * 48000);
    expect(INTRO_MUSIC_REVEAL).toBe(4);
    const drums = INTRO_MUSIC.parts.find((p) => p.role === "drums")!;
    expect(Math.min(...drums.notes.filter((n) => n.drum === "kick").map((n) => n.at))).toBe(8);
  });
});

describe("實際算成聲音（node-web-audio-api）", () => {
  const factory: ContextFactory = (channels, length, rate) => new NodeOfflineAudioContext(channels, length, rate) as unknown as OfflineAudioContext;
  const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

  it("四種音效與配樂都有聲音、不爆音", async () => {
    const plan = flipIntro({ imageIds: images, title: "x", fps: 30, seed: 1 });
    for (const [key, spec] of Object.entries(introSoundSpecs(plan))) {
      const x = await renderSound(spec, factory);
      expect(peak(x), key).toBeGreaterThan(0.05);
      expect(peak(x), key).toBeLessThanOrEqual(0.9);
    }
    const music = await renderMusic(INTRO_MUSIC, factory);
    // 揭曉前（第 1 小節）比揭曉後（第 3 小節）小聲：重拍落地有落差
    const rms = (a: number, b: number) => Math.sqrt(music.slice(a * 48000, b * 48000).reduce((s, v) => s + v * v, 0) / ((b - a) * 48000));
    expect(rms(4, 6)).toBeGreaterThan(rms(0.5, 2) * 1.5);
  }, 30_000);
});
