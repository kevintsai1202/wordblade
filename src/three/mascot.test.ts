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
