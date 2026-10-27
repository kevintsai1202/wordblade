/// <reference types="node" />
// 鏡頭關鍵幀的內插（經典腳本 cameraPath.js，串在 3D 場景插件前面送進沙盒；這裡用 vm 載入測）
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

const context = vm.createContext({});
vm.runInContext(readFileSync(join(import.meta.dirname, "cameraPath.js"), "utf8"), context);
const CAMERA3D = vm.runInContext("CAMERA3D", context);

const keys = [
  { t: 1, position: [0, 4, 10], target: [0, 1, 0], fov: 40 },
  { t: 3, position: [4, 2, 6], target: [0, 1, 0], fov: 30 },
];

describe("CAMERA3D.cameraAt（spec §5.8 鏡頭關鍵幀）", () => {
  it("第一個關鍵幀之前停在第一個、最後一個之後停在最後一個", () => {
    expect(CAMERA3D.cameraAt(keys, 0)).toEqual({ position: [0, 4, 10], target: [0, 1, 0], fov: 40 });
    expect(CAMERA3D.cameraAt(keys, 9)).toEqual({ position: [4, 2, 6], target: [0, 1, 0], fov: 30 });
  });

  it("中間依 smoothstep 內插（正中間＝一半）", () => {
    const mid = CAMERA3D.cameraAt(keys, 2);
    expect(mid.position).toEqual([2, 3, 8]);
    expect(mid.fov).toBe(35);
    const quarter = CAMERA3D.cameraAt(keys, 1.5);  // smoothstep(0.25) = 0.15625
    expect(quarter.position[0]).toBeCloseTo(4 * 0.15625, 6);
  });

  it("關鍵幀沒照時間排序也可以；空的回 null", () => {
    expect(CAMERA3D.cameraAt([keys[1], keys[0]], 2).position).toEqual([2, 3, 8]);
    expect(CAMERA3D.cameraAt([], 2)).toBeNull();
  });
});
