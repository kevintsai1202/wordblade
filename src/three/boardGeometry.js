'use strict';
/** 「漂浮的板子」的 three.js 幾何（經典腳本，全域 BOARD3D；串在 3D 插件前面送進沙盒，Vitest 用 node vm 載入）。
 *  原專案（vendor/plane3d_math.js）的投影：鏡頭在原點看 +Z、畫面 y 往下、水平視角 40°（f＝w/2×D0），板子四角在相機座標 (X, Y, Z)。
 *  three.js 的鏡頭看 −Z、y 往上，所以四角換成 (X, −Y, −Z)，垂直視角取 2·atan(tan(20°)·h/w)；這樣投影出來的四角和 PLANE3D.corners 完全一樣
 *  （boardGeometry.test.ts 用 PerspectiveCamera 對照驗證）。依賴 PLANE3D。 */
const BOARD3D = (() => {
  const P = PLANE3D;
  const rad = (deg) => deg * Math.PI / 180;

  /** three.js 鏡頭的垂直視角（度）：原專案用水平 40° */
  function verticalFov(w, h) {
    return 2 * Math.atan(Math.tan(rad(P.FOV_DEG / 2)) * h / w) * 180 / Math.PI;
  }

  /** 板子四角在 three.js 相機座標（鏡頭在原點、看 −Z）的位置：左上、右上、左下、右下，各 [x, y, z] */
  function cornersInCamera(pose, w, h) {
    const rz = rad(pose.rz), rx = rad(pose.rx), ry = rad(pose.ry);
    const d = P.D0 / pose.size;
    const hw = 1, hh = h / w;
    const tx = pose.px * 2 / pose.size, ty = pose.py * 2 * (h / w) / pose.size;
    return [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]].map(([lx, ly]) => {
      const x1 = lx * Math.cos(rz) - ly * Math.sin(rz), y1 = lx * Math.sin(rz) + ly * Math.cos(rz);
      const y2 = y1 * Math.cos(rx), z2 = y1 * Math.sin(rx);
      const x3 = x1 * Math.cos(ry) + z2 * Math.sin(ry), z3 = -x1 * Math.sin(ry) + z2 * Math.cos(ry);
      return [x3 + tx, -(y2 + ty), -(z3 + d)];
    });
  }

  return { verticalFov, cornersInCamera };
})();
