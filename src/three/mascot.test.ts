/// <reference types="node" />
// 吉祥物站的位置（docs/plan-11-01-directives.md）：目標框在畫面最上方、貼著左邊時（OBS 實測的標題），角色要整個在畫面裡，而且真的走一段路。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

// mascot.js 是經典腳本：用 vm 執行，取出全域的 standPose
const context = vm.createContext({});
vm.runInContext(readFileSync(join(import.meta.dirname, "builtins/mascot.js"), "utf8"), context, { filename: "mascot.js" });
const standPose = vm.runInContext("standPose", context) as (box: { cx: number; cy: number; w: number; h: number }, fromLeft: boolean, height: number, aspect: number) =>
  { startX: number; standX: number; footY: number; halfW: number };

/** 角色（腳底 footY、高 height、半寬 halfW）整個在畫面裡 */
function inside(p: { standX: number; footY: number; halfW: number }, height: number) {
  expect(p.footY).toBeLessThanOrEqual(1);
  expect(p.footY - height).toBeGreaterThanOrEqual(0);
  expect(p.standX - p.halfW).toBeGreaterThanOrEqual(0);
  expect(p.standX + p.halfW).toBeLessThanOrEqual(1);
}

describe("吉祥物站的位置", () => {
  it("目標在最上方、貼左邊（實測的標題）：站在框下面、整個在畫面裡、從左邊走進來至少走 0.15 個畫面寬", () => {
    const box = { cx: 0.35, cy: 0.12, w: 0.66, h: 0.06 };
    const p = standPose(box, true, 0.35, 16 / 9);
    inside(p, 0.35);
    expect(p.footY - 0.35).toBeGreaterThanOrEqual(box.cy + box.h / 2 - 0.001);
    expect(p.standX - p.startX).toBeGreaterThan(0.15);
  });

  it("目標在畫面中間：站在框旁邊、腳對齊框下緣", () => {
    const box = { cx: 0.5, cy: 0.6, w: 0.2, h: 0.1 };
    const p = standPose(box, true, 0.35, 16 / 9);
    inside(p, 0.35);
    expect(p.footY).toBeCloseTo(0.65);
    expect(p.standX).toBeLessThan(box.cx - box.w / 2);
  });

  it("從右邊進來、目標貼右下角：還是在畫面裡", () => {
    const p = standPose({ cx: 0.9, cy: 0.9, w: 0.2, h: 0.2 }, false, 0.35, 16 / 9);
    inside(p, 0.35);
    expect(p.startX).toBeGreaterThan(1);
  });
});

// 機器人造型（2026-11-03，demo 用；造型參考第一次 Vibe 3D 試做的 f1.jpg，程式重寫）：深色方塊身體、青綠發光臉、圓耳、天線
describe("機器人造型", () => {
  it("和原本的角色一樣的部位、大小（高約 2.6、半寬不超過 0.7），standPose 的換算才對得上", async () => {
    const THREE = await import("three");
    const ctx = vm.createContext({});
    vm.runInContext(readFileSync(join(import.meta.dirname, "builtins/mascot.js"), "utf8"), ctx, { filename: "mascot.js" });
    const buildRobot = vm.runInContext("buildRobot", ctx) as (three: typeof THREE, color: InstanceType<typeof THREE.Color>) => Record<string, InstanceType<typeof THREE.Object3D>>;
    const parts = buildRobot(THREE, new THREE.Color("#14171c"));
    for (const k of ["root", "head", "armL", "armR", "legL", "legR"]) expect(parts[k]).toBeTruthy();
    parts.root.updateMatrixWorld(true);
    const size = new THREE.Box3().setFromObject(parts.root).getSize(new THREE.Vector3());
    expect(size.y).toBeGreaterThan(2.3);
    expect(size.y).toBeLessThan(2.9);
    expect(size.x / 2).toBeLessThanOrEqual(0.75);
    const bottom = new THREE.Box3().setFromObject(parts.root).min.y;
    expect(Math.abs(bottom)).toBeLessThan(0.05);
  });
});

// 面向對方（2026-11-03 demo：3D 機器人和 2D 的自己互相打招呼）：走到了以後身體轉 3/4 朝向目標框，不是永遠正對鏡頭
describe("走到了以後轉向目標", () => {
  it("從右邊走進來 → 停下後轉向左邊的框（rotation.y 約 −0.55）；從左邊 → 約 +0.55", async () => {
    const THREE = await import("three");
    for (const [from, sign] of [["right", -1], ["left", 1]] as const) {
      const ctx = vm.createContext({});
      vm.runInContext(readFileSync(join(import.meta.dirname, "builtins/mascot.js"), "utf8"), ctx, { filename: "mascot.js" });
      const setup = vm.runInContext("setup", ctx) as (three: typeof THREE, scene: unknown, camera: unknown, env: unknown) => void;
      const update = vm.runInContext("update", ctx) as (t: number, env: unknown) => void;
      const M = vm.runInContext("M", ctx) as { parts: { root: { rotation: { y: number } } } };
      const env = { duration: 6, box: { cx: 0.5, cy: 0.6, w: 0.2, h: 0.2 }, params: { style: "robot", action: "wave", from, walk: 1.6 } };
      setup(THREE, new THREE.Scene(), new THREE.PerspectiveCamera(35, 16 / 9, 0.1, 100), env);
      update(4, env);
      expect(M.parts.root.rotation.y).toBeCloseTo(0.55 * sign, 2);
    }
  });
});
