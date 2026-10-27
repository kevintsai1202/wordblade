import { describe, expect, it } from "vitest";
import { addEffect, deleteEffect, effectPlan, moveEffect, setEffectCameraKeys, setEffectParams, trimEffect } from "./effects";
import { makeProject } from "./fixtures";
import type { Effect, Plugin } from "./model";

/** 一個 2D 特效 */
function fx(id: string, start: number, end: number): Effect {
  return { id, kind: "anim2d", start, end, pluginId: "h-box", params: { box: { cx: 0.5, cy: 0.5, w: 0.3, h: 0.2 }, layers: [{ component: "h-box", params: {} }] }, anchorIds: [] };
}
const plugin: Plugin = { hash: "h-box", kind: "2d", source: "builtin", component: { id: "box" } };

describe("特效編輯（§5.7）", () => {
  it("addEffect：加特效與它用到的插件；同一個插件不重複加", () => {
    let p = addEffect(makeProject(), fx("a", 2, 4), [plugin]);
    p = addEffect(p, fx("b", 5, 6), [plugin]);
    expect(p.effects.map((e) => e.id)).toEqual(["e1", "a", "b"]);
    expect(p.plugins).toHaveLength(1);
  });

  it("addEffect：id 重複時原樣回傳", () => {
    const p = addEffect(makeProject(), fx("a", 2, 4), [plugin]);
    expect(addEffect(p, fx("a", 0, 1), [])).toBe(p);
  });

  it("moveEffect：長度不變、起點不小於 0", () => {
    const p = addEffect(makeProject(), fx("a", 2, 4), [plugin]);
    const moved = moveEffect(p, "a", 7.5).effects.find((e) => e.id === "a")!;
    expect([moved.start, moved.end]).toEqual([7.5, 9.5]);
    const clamped = moveEffect(p, "a", -3).effects.find((e) => e.id === "a")!;
    expect([clamped.start, clamped.end]).toEqual([0, 2]);
  });

  it("trimEffect：拖起點或終點，最短 0.1 秒、起點不小於 0", () => {
    const p = addEffect(makeProject(), fx("a", 2, 4), [plugin]);
    const out = trimEffect(p, "a", "out", 3.2).effects.find((e) => e.id === "a")!;
    expect([out.start, out.end]).toEqual([2, 3.2]);
    const tooShort = trimEffect(p, "a", "in", 3.99).effects.find((e) => e.id === "a")!;
    expect([tooShort.start, tooShort.end]).toEqual([3.9, 4]);
    const neg = trimEffect(p, "a", "in", -1).effects.find((e) => e.id === "a")!;
    expect(neg.start).toBe(0);
  });

  it("deleteEffect、setEffectParams；找不到 id 原樣回傳", () => {
    const p = addEffect(makeProject(), fx("a", 2, 4), [plugin]);
    expect(deleteEffect(p, "a").effects.map((e) => e.id)).toEqual(["e1"]);
    const params = { box: { cx: 0.2, cy: 0.3, w: 0.1, h: 0.1 }, layers: [] };
    expect(setEffectParams(p, "a", params).effects.find((e) => e.id === "a")!.params).toEqual(params);
    expect(deleteEffect(p, "nope")).toBe(p);
    expect(moveEffect(p, "nope", 1)).toBe(p);
  });
});

describe("effectPlan（每格要畫哪些 2D 特效）", () => {
  it("回傳時間 t 時有效的 anim2d 特效，依起點排序，附區段內的格數與長度", () => {
    let p = addEffect(makeProject(), fx("a", 2, 4), [plugin]);
    p = addEffect(p, fx("b", 1, 3), [plugin]);
    expect(effectPlan(p, 2.5, 30)).toEqual([
      { effectId: "b", frame: 45, duration: 2 },
      { effectId: "a", frame: 15, duration: 2 },
    ]);
  });

  it("終點不含、3D 特效不在這裡（e1 是 anim3d）", () => {
    const p = addEffect(makeProject(), fx("a", 2, 4), [plugin]);
    expect(effectPlan(p, 4, 30)).toEqual([]);
    expect(effectPlan(p, 9, 30)).toEqual([]);
  });
});

describe("setEffectCameraKeys", () => {
  it("換掉特效的鏡頭關鍵幀（依時間排序），找不到 id 原樣回傳", () => {
    const p = addEffect(makeProject(), fx("a", 2, 4), [plugin]);
    const k1 = { t: 1.5, position: [0, 0, 5] as [number, number, number], target: [0, 0, 0] as [number, number, number], fov: 40 };
    const k0 = { ...k1, t: 0.5 };
    expect(setEffectCameraKeys(p, "a", [k1, k0]).effects.find((e) => e.id === "a")!.cameraKeys!.map((k) => k.t)).toEqual([0.5, 1.5]);
    expect(setEffectCameraKeys(p, "nope", [k0])).toBe(p);
  });
});
