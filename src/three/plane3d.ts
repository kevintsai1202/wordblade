// 主程式用的板子姿勢數學：載入原專案的 vendor/plane3d_math.js（經典腳本，全域 PLANE3D）。
// 和沙盒 Worker、Vitest 用的是同一份檔案；這裡給「用說的」檢查 AI 的提議（關鍵幀時間、姿勢路徑）。
import plane3d from "./vendor/plane3d_math.js?global=PLANE3D";

/** 姿勢 */
export interface Pose {
  rx: number;
  ry: number;
  rz: number;
  size: number;
  px: number;
  py: number;
}

/** 原專案姿勢數學（只列這裡用到的） */
export interface Plane3dMath {
  FLAT: Pose;
  keyTimes(effect: { keys: unknown[]; edges: boolean }, length: number): number[];
  pathValid(keys: unknown[], float: unknown, w: number, h: number): boolean;
}

/** 經典腳本的 PLANE3D（vite.config.ts 的 classicGlobalPlugin 把它變成模組；不執行字串，父頁 CSP 不放行 eval） */
export const PLANE3D: Plane3dMath = plane3d as Plane3dMath;
