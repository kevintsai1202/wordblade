/// <reference types="node" />
// 「漂浮的板子」的幾何：用 three.js 的 PerspectiveCamera 投影板子四角，必須和原專案的 PLANE3D.corners 一樣（畫面才會和「用說的」描述一致）。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { PerspectiveCamera, Vector3 } from "three";
import { describe, expect, it } from "vitest";

// 兩支都是經典腳本（repo 是 type: module，不能 require）：用 vm 依序執行，取出全域的 PLANE3D、BOARD3D（同沙盒 Worker 的串接方式）
const context = vm.createContext({});
for (const f of ["vendor/plane3d_math.js", "boardGeometry.js"]) vm.runInContext(readFileSync(join(import.meta.dirname, f), "utf8"), context, { filename: f });
const PLANE3D = vm.runInContext("PLANE3D", context);
const BOARD3D = vm.runInContext("BOARD3D", context);

type Pose = { rx: number; ry: number; rz: number; size: number; px: number; py: number };

/** 用 three.js 鏡頭把板子四角投影到畫面像素 */
function projectWithThree(pose: Pose, w: number, h: number): number[][] {
  const camera = new PerspectiveCamera(BOARD3D.verticalFov(w, h), w / h, 0.01, 1000);
  camera.updateMatrixWorld();
  camera.updateProjectionMatrix();
  return BOARD3D.cornersInCamera(pose, w, h).map(([x, y, z]: number[]) => {
    const v = new Vector3(x, y, z).project(camera);
    return [(v.x + 1) / 2 * w, (1 - v.y) / 2 * h];
  });
}

describe("板子幾何（three.js 投影＝原專案的 PLANE3D.corners）", () => {
  it("滿版：四角就是畫面四角", () => {
    const got = projectWithThree(PLANE3D.FLAT, 1920, 1080);
    expect(got.flat().map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0, 1920, 0, 0, 1080, 1920, 1080]);
  });

  it("原專案的固定值（size＝D0／3.3）也對得上 corners（pad 0）", () => {
    const pose = { ...PLANE3D.FLAT, size: PLANE3D.D0 / 3.3 };
    const got = projectWithThree(pose, 1920, 1080);
    const want = PLANE3D.corners(pose, 1920, 1080, 0);
    got.flat().forEach((v, i) => expect(v).toBeCloseTo(want.flat()[i], 6));
  });

  it("200 組隨機有效姿勢：誤差小於 0.01 像素（橫式與直式）", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
    let checked = 0;
    for (const [w, h] of [[1920, 1080], [1080, 1920]]) {
      while (checked < (w === 1920 ? 100 : 200)) {
        const pose = { rx: rnd() * 120 - 60, ry: rnd() * 120 - 60, rz: rnd() * 90 - 45, size: 0.3 + rnd() * 1.1, px: rnd() - 0.5, py: rnd() - 0.5 };
        if (!PLANE3D.poseValid(pose, w, h)) continue;
        const got = projectWithThree(pose, w, h);
        const want = PLANE3D.corners(pose, w, h, 0);
        got.flat().forEach((v, i) => expect(Math.abs(v - want.flat()[i])).toBeLessThan(0.01));
        checked++;
      }
    }
  });

  it("原專案的時間規則：頭尾 0.6 秒回滿版、錨定結尾的關鍵幀從尾巴往前算", () => {
    const effect = { edges: true, float: null, keys: [{ anchor: "start", t: 0, rx: 0, ry: 55, rz: 0, size: 0.55, px: 0.12, py: 0 }, { anchor: "end", t: 0, rx: 0, ry: 0, rz: 0, size: 0.82, px: 0, py: 0 }] };
    expect(PLANE3D.poseAt(effect, 6, 0)).toEqual(PLANE3D.FLAT);
    expect(PLANE3D.poseAt(effect, 6, 6)).toEqual({ rx: 0, ry: 0, rz: 0, size: 1, px: 0, py: 0 });
    expect(PLANE3D.poseAt(effect, 6, 0.6).ry).toBeCloseTo(55, 6);
    expect(PLANE3D.poseAt(effect, 6, 5.4).size).toBeCloseTo(0.82, 6);
  });
});
