// 主程式用的板子姿勢數學：載入原專案的 vendor/plane3d_math.js（經典腳本，全域 PLANE3D）。
// 和沙盒 Worker、Vitest 用的是同一份檔案；這裡給「用說的」檢查 AI 的提議（關鍵幀時間、姿勢路徑）。
import source from "./vendor/plane3d_math.js?raw";

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

/** 執行經典腳本、取出 PLANE3D（我們自己隨程式附的檔，不是使用者或 AI 的程式） */
export const PLANE3D: Plane3dMath = new Function(`${source}\n;return PLANE3D;`)() as Plane3dMath;
