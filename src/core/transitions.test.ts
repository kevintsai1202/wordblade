// 轉場（§5.9）、色彩調整（P3）、定格（§5.20）的純函式測試（2026-11-02）
import { describe, expect, it } from "vitest";
import { makeProject } from "./fixtures";
import { setTransition, transitionCuts, transitionLook, visibleRange, extendedSource } from "./transitions";
import { gradeAt, setColorGrade } from "./colorGrade";
import { insertFreeze, rippleDelete, clipEnd } from "./timeline";
import { framePlan } from "../compositor/framePlan";
import { clipFrames } from "../export/exportPlan";

describe("轉場", () => {
  // fixtures：V1 = v1a 0～10（m1 0～10）、v1b 10～20（m1 20～30）、v1c 20～30（m2 0～10）
  const p = setTransition(makeProject(), "v1b", "dissolve", 1);

  it("接點在 10 秒、半長 0.5；前一段延到 10.5、後一段提早到 9.5", () => {
    const [cut] = transitionCuts(p);
    expect(cut.t).toBe(10);
    expect(cut.half).toBe(0.5);
    expect(visibleRange([cut], cut.prev)).toEqual({ from: 0, to: 10.5 });
    expect(visibleRange([cut], cut.next)).toEqual({ from: 9.5, to: 20 });
  });

  it("溶接：前一段維持 1、後一段用進度（預乘疊加，中間不會變暗）", () => {
    expect(transitionLook("dissolve", 0.25)).toMatchObject({ prev: { opacity: 1 }, next: { opacity: 0.25 } });
  });

  it("10 秒前 0.25 秒兩段都畫：前一段在下、素材時間照常；後一段在上、素材時間往前推", () => {
    const layers = framePlan(p, 9.75);
    expect(layers.slice(0, 2).map((l) => l.clipId)).toEqual(["v1a", "v1b"]);
    expect(layers[0].srcTime).toBeCloseTo(9.75);
    expect(layers[1].srcTime).toBeCloseTo(19.75);
    expect(layers[1].opacity).toBeCloseTo(0.25);
  });

  it("延伸超出素材範圍就停在第一格／最後一格", () => {
    const pr = makeProject();
    const clip = pr.clips.find((c) => c.id === "v1c")!;
    expect(extendedSource(clip, 19, pr.media.find((m) => m.id === "m2"))).toBe(0);
    const tail = { ...clip, srcIn: 295, srcOut: 300, start: 0 };
    expect(extendedSource(tail, 6, pr.media.find((m) => m.id === "m2"))).toBeCloseTo(299.98);
  });

  it("穿白：接點前半段上面蓋白色、接點時全白", () => {
    const w = setTransition(makeProject(), "v1b", "dipWhite", 1);
    const at = framePlan(w, 9.99);
    const solid = at.find((l) => l.solid);
    expect(solid?.solid).toEqual([1, 1, 1]);
    expect(solid!.opacity).toBeGreaterThan(0.95);
  });

  it("推移：前一段往左移、後一段從右邊進來", () => {
    const push = setTransition(makeProject(), "v1b", "pushLeft", 1);
    const layers = framePlan(push, 10);
    expect(layers.find((l) => l.clipId === "v1a")!.rect.x).toBeCloseTo(-0.5);
    expect(layers.find((l) => l.clipId === "v1b")!.rect.x).toBeCloseTo(0.5);
  });

  it("不改總長度；拿掉前一段後轉場不畫", () => {
    expect(clipEnd(p.clips.find((c) => c.id === "v1c")!)).toBe(30);
    expect(transitionCuts(setTransition(p, "v1a", "dissolve"))).toHaveLength(1);
    const removed = rippleDelete(p, 0, 10);
    expect(transitionCuts(removed)).toHaveLength(0);
  });

  it("匯出解格範圍跟著延伸（30 fps：後一段從第 285 格開始）", () => {
    const ranges = clipFrames(p, 30, 900);
    const next = ranges.find((r) => r.clipId === "v1b")!;
    expect(next.first).toBe(285);
    expect(next.srcTimes[0]).toBeCloseTo(19.5);
    expect(ranges.find((r) => r.clipId === "v1a")!.last).toBe(314);
  });

  it("長度夾在 0.1～2 秒；kind null 拿掉", () => {
    expect(setTransition(makeProject(), "v1b", "dissolve", 9).transitions![0].duration).toBe(2);
    expect(setTransition(p, "v1b", null).transitions).toHaveLength(0);
  });
});

describe("色彩調整", () => {
  const v = { brightness: 0.5, contrast: 0, saturation: -1, temperature: 0 };

  it("沒選範圍＝整條（到結尾，之後加的也套）；圖層帶 grade", () => {
    const p = setColorGrade(makeProject(), "g1", v);
    expect(p.colorGrades![0].end).toBeUndefined();
    expect(gradeAt(p, 999)).toMatchObject(v);
    expect(framePlan(p, 5)[0].grade).toMatchObject(v);
  });

  it("選範圍只調那段；後加的蓋前面的", () => {
    let p = setColorGrade(makeProject(), "all", v);
    p = setColorGrade(p, "part", { ...v, brightness: -0.5 }, { start: 5, end: 8 });
    expect(gradeAt(p, 6)!.brightness).toBe(-0.5);
    expect(gradeAt(p, 9)!.brightness).toBe(0.5);
  });

  it("漣漪刪除時範圍跟著往前移", () => {
    const p = rippleDelete(setColorGrade(makeProject(), "part", v, { start: 12, end: 15 }), 0, 10);
    expect(p.colorGrades![0]).toMatchObject({ start: 2, end: 5 });
  });

  it("全部 0 等於沒調", () => {
    expect(gradeAt(setColorGrade(makeProject(), "z", { brightness: 0, contrast: 0, saturation: 0, temperature: 0 }), 1)).toBeNull();
  });
});

describe("定格", () => {
  it("在 5 秒插 2 秒定格：V1 變成 0～5、定格 5～7（停在素材 5 秒）、後半段 7～12；總長多 2 秒；對白軌在 5～7 是空的", () => {
    const p = insertFreeze(makeProject(), 5, 2);
    const v1 = p.clips.filter((c) => c.trackId === "V1").sort((a, b) => a.start - b.start);
    expect(v1.map((c) => [c.start, clipEnd(c)])).toEqual([[0, 5], [5, 7], [7, 12], [12, 22], [22, 32]]);
    expect(v1[1].freeze).toEqual({ at: 5, hold: 2 });
    expect(framePlan(p, 6)[0].srcTime).toBe(5);
    const a1 = p.clips.filter((c) => c.trackId === "A1");
    expect(a1.some((c) => c.start < 7 && clipEnd(c) > 5)).toBe(false);
  });

  it("定格的連續格素材時間相同（匯出只解一次）", () => {
    const r = clipFrames(insertFreeze(makeProject(), 5, 2), 30, 960).find((x) => x.clipId.includes("freeze"))!;
    expect(new Set(r.srcTimes)).toEqual(new Set([5]));
  });
});
