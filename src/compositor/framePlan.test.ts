import { describe, expect, it } from "vitest";
import { makeClip, makeProject } from "../core/fixtures";
import { addVoiceover, setVoiceoverActive } from "../core/voiceover";
import { audioPlan, framePlan } from "./framePlan";

describe("framePlan（§5.10 疊放順序）", () => {
  it("V1 在最下面，疊加軌依軌道順序往上；每層帶素材時間與框", () => {
    const p = makeProject();
    p.clips.find((c) => c.id === "v2")!.transform = { x: 0.7, y: 0.05, w: 0.25, h: 0.25 };
    const plan = framePlan(p, 13);
    expect(plan.map((l) => [l.clipId, l.srcTime])).toEqual([["v1b", 23], ["v2", 51]]);
    expect(plan[0].rect).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(plan[1].rect).toEqual({ x: 0.7, y: 0.05, w: 0.25, h: 0.25 });
  });

  it("沒有片段的時間點（V1 結束之後）回空清單", () => {
    expect(framePlan(makeProject(), 40)).toEqual([]);
  });

  it("片段終點不含（終點那一格屬於下一個片段）", () => {
    expect(framePlan(makeProject(), 10).map((l) => l.clipId)).toEqual(["v1b"]);
  });

  it("變速片段：素材時間依速度換算", () => {
    const p = makeProject();
    p.clips = [makeClip({ id: "f", mediaId: "m1", trackId: "V1", srcIn: 10, srcOut: 30, start: 0, speed: 2 })];
    expect(framePlan(p, 4)[0].srcTime).toBe(18);
  });

  it("淡入淡出換算成透明度", () => {
    const p = makeProject();
    const v2 = p.clips.find((c) => c.id === "v2")!;
    v2.fadeIn = 1;
    v2.opacity = 0.8;
    expect(framePlan(p, 12.5).find((l) => l.clipId === "v2")!.opacity).toBeCloseTo(0.4);
  });

  it("靜音的軌道不影響畫面，但隱藏（muted）的影像軌不畫", () => {
    const p = makeProject();
    p.tracks.find((t) => t.id === "V2")!.muted = true;
    expect(framePlan(p, 13).map((l) => l.clipId)).toEqual(["v1b"]);
  });
});

describe("audioPlan", () => {
  it("列出這個時間點要發聲的音訊片段與素材時間，軌道靜音的不算", () => {
    const p = makeProject();
    p.tracks.find((t) => t.id === "A2")!.muted = true;
    expect(audioPlan(p, 13).map((a) => [a.clipId, a.srcTime])).toEqual([["a1b", 23]]);
  });
});

describe("audioPlan 與重配音（§5.6）", () => {
  const withVo = () => {
    const p = makeProject();
    p.media.push({ id: "vo1", kind: "audio", duration: 5 });
    return addVoiceover(p, { id: "vo-a", start: 2, end: 7, text: "x", mediaId: "vo1" });
  };
  const gains = (p: ReturnType<typeof withVo>, t: number) => Object.fromEntries(audioPlan(p, t).map((a) => [a.clipId, a.gain]));

  it("生效：範圍內對白增益 0、AI 片段有聲；範圍外對白照常", () => {
    const p = withVo();
    const vc = p.voiceovers![0].clipId;
    expect(gains(p, 4)).toMatchObject({ a1a: 0, [vc]: 1, a2: 1 });
    expect(gains(p, 8).a1a).toBe(1);
    expect(gains(p, 1).a1a).toBe(1);
  });

  it("切回原音：對白有聲、AI 片段增益 0", () => {
    const p = setVoiceoverActive(withVo(), "vo-a", false);
    const vc = p.voiceovers![0].clipId;
    expect(gains(p, 4)).toMatchObject({ a1a: 1, [vc]: 0 });
  });
});
