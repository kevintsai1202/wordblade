'use strict';
/** 3D 場景的鏡頭關鍵幀內插（spec §5.8；經典腳本，全域 CAMERA3D，串在場景插件前面送進沙盒，Vitest 用 vm 測）。
 *  關鍵幀 {t（相對區段開頭的秒數）, position [x,y,z], target [x,y,z]（看向的點）, fov（垂直視角，度）}；
 *  兩個關鍵幀之間用 smoothstep（慢進慢出），第一個之前停在第一個、最後一個之後停在最後一個。 */
const CAMERA3D = (() => {
  /** 慢進慢出 */
  const smooth = (u) => { const x = Math.min(1, Math.max(0, u)); return x * x * (3 - 2 * x); };
  /** 向量線性內插 */
  const mix = (a, b, k) => a.map((v, i) => v + (b[i] - v) * k);

  /** 時間 t 的鏡頭；沒有關鍵幀回 null */
  function cameraAt(keys, t) {
    if (!keys || !keys.length) return null;
    const ks = [...keys].sort((a, b) => a.t - b.t);
    const pick = (k) => ({ position: [...k.position], target: [...k.target], fov: k.fov });
    if (t <= ks[0].t) return pick(ks[0]);
    for (let i = 1; i < ks.length; i++) {
      const a = ks[i - 1], b = ks[i];
      if (t < b.t) {
        const k = smooth((t - a.t) / (b.t - a.t));
        return { position: mix(a.position, b.position, k), target: mix(a.target, b.target, k), fov: a.fov + (b.fov - a.fov) * k };
      }
    }
    return pick(ks[ks.length - 1]);
  }

  return { cameraAt };
})();
