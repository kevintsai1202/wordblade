'use strict';
/** 平面轉 3D 共用數學（純函式：沒有 DOM、沒有全域狀態，node 可直接載入測試）。
 *  與 backend/plane3d_math.py 對稱實作，scripts/plane3d-math-parity.js 比對兩邊輸出；改一邊一定要同步改另一邊，
 *  否則工作台預覽、MP4 與 XML 的板子位置會對不上。設計見 docs/superpowers/specs/2026-10-25-plane3d-design.md §2、§3。
 *  ffmpeg 運算式只有引擎需要，這裡沒有。
 *
 *  座標約定：姿勢 pose＝{rx, ry, rz, size, px, py}，角度用度；size＝正對鏡頭時板子寬佔畫面寬的比例（1＝滿版）；
 *  px／py 以畫面寬、高為 1。旋轉順序 Rz → Rx → Ry，四角順序左上、右上、左下、右下。 */
const PLANE3D = (() => {
  const FOV_DEG = 40;
  const D0 = 1 / Math.tan(FOV_DEG * Math.PI / 180 / 2);   // size=1（滿版）時的距離
  const PAD = 4;              // 輸出時來源外圍的透明邊（px）；預覽不用
  const EDGE_RAMP = 0.6;      // 頭尾接回平面的秒數（區間太短時取 L/4）
  const MAX_KEYS = 20;
  const MIN_Z = 0.3 * D0;     // 任一角離鏡頭的最近距離
  const MAX_SPREAD = 4;       // 投影點離畫面中心最多幾倍畫面寬／高
  const SHADOW_DY = 0.026;   // 陰影往下偏移（以畫面高為 1）；預覽與輸出共用
  const SHADOW_SIGMA = 0.02; // 陰影模糊的標準差（以畫面高為 1）
  const FLAT = {rx: 0, ry: 0, rz: 0, size: 1, px: 0, py: 0};
  const PARAMS = ['rz', 'rx', 'ry', 'size', 'px', 'py'];
  const RANGES = {rx: [-80, 80], ry: [-80, 80], rz: [-180, 180], size: [0.15, 1.5], px: [-1, 1], py: [-1, 1]};
  const FLOAT_RANGES = {rx: [0, 15], ry: [0, 15], period: [1, 10]};
  const EASES = ['inOut', 'linear', 'in', 'out'];
  const rad = (deg) => deg * Math.PI / 180;

  /** 緩動：inOut＝easeInOutCubic、in＝u³、out＝1−(1−u)³、linear。u 夾在 0～1。 */
  function ease(kind, u) {
    u = Math.min(1, Math.max(0, u));
    if (kind === 'linear') return u;
    if (kind === 'in') return u ** 3;
    if (kind === 'out') return 1 - (1 - u) ** 3;
    return u < 0.5 ? 4 * u ** 3 : 1 - (2 - 2 * u) ** 3 / 2;
  }

  /** 頭尾接回平面的秒數。 */
  const edgeRamp = (L) => Math.min(EDGE_RAMP, L / 4);

  /** 每個使用者關鍵幀的剪後時間（秒，相對區段開頭）；edges 開時 ramp 加在使用者關鍵幀外面。不是嚴格遞增時丟錯。 */
  function keyTimes(effect, L) {
    const r = effect.edges ? edgeRamp(L) : 0;
    const out = effect.keys.map((k) => Math.min(L - r, Math.max(r, (k.anchor || 'start') === 'start' ? r + k.t : L - r - k.t)));
    for (let i = 1; i < out.length; i++) if (out[i] <= out[i - 1]) throw new Error('plane3d: key times not increasing');
    return out;
  }

  /** 實際使用的關鍵幀時間：keyTimes 不遞增時（區間剪到太短）照順序平均排在 [r, L−r]。 */
  function resolvedTimes(effect, L) {
    try { return keyTimes(effect, L); } catch (err) {
      const r = effect.edges ? edgeRamp(L) : 0, n = effect.keys.length;
      return n > 1 ? effect.keys.map((_, i) => r + (L - 2 * r) * i / (n - 1)) : [r];
    }
  }

  /** 關鍵幀路徑可不可以用：每個點與相鄰兩點之間每 0.1 取樣（有 float 再加四個擺動極端），全部 poseValid。 */
  function pathValid(keys, float, w, h) {
    const poses = keys.map((k) => Object.fromEntries(PARAMS.map((p) => [p, k[p]])));
    let samples = [...poses];
    for (let i = 1; i < poses.length; i++) {
      const a = poses[i - 1], b = poses[i];
      for (let j = 1; j < 10; j++) samples.push(Object.fromEntries(PARAMS.map((p) => [p, a[p] + (b[p] - a[p]) * j / 10])));
    }
    if (float) samples = samples.flatMap((s) => [-1, 1].flatMap((sx) => [-1, 1].map((sy) => ({...s, rx: s.rx + sx * float.rx, ry: s.ry + sy * float.ry}))));
    return samples.every((s) => poseValid(s, w, h));
  }

  /** 內插節點 [{T, pose, ease}]；edges 開時頭尾各加滿版平面與 ramp（一律 inOut），同一時間點留前面那個。 */
  function nodes(effect, L) {
    const ts = resolvedTimes(effect, L);
    let ns = effect.keys.map((k, i) => ({T: ts[i], pose: Object.fromEntries(PARAMS.map((p) => [p, k[p]])), ease: k.ease || 'inOut'}));
    const r = effect.edges ? edgeRamp(L) : 0;
    if (effect.edges && r > 0) {
      ns = [{T: 0, pose: {...FLAT}, ease: 'inOut'}, {T: r, pose: {...ns[0].pose}, ease: 'inOut'}, ...ns,
        {T: L - r, pose: {...ns[ns.length - 1].pose}, ease: 'inOut'}, {T: L, pose: {...FLAT}, ease: 'inOut'}];
      ns = ns.filter((n, i) => i === 0 || n.T > ns[i - 1].T);
    }
    return ns;
  }

  /** 擺動權重：edges 開時頭尾 ramp 內從 0 漸到 1。 */
  function floatWeight(effect, L, T) {
    if (!effect.edges) return 1;
    const r = edgeRamp(L);
    return r <= 0 ? 1 : ease('inOut', T / r) * ease('inOut', (L - T) / r);
  }

  /** 剪後時間 T 的姿勢：關鍵幀分段內插＋float 擺動。 */
  function poseAt(effect, L, T) {
    const ns = nodes(effect, L);
    let pose = {...ns[ns.length - 1].pose};
    if (T <= ns[0].T) pose = {...ns[0].pose};
    else {
      for (let i = 1; i < ns.length; i++) {
        const a = ns[i - 1], b = ns[i];
        if (T < b.T) {
          const e = ease(b.ease, (T - a.T) / (b.T - a.T));
          pose = Object.fromEntries(PARAMS.map((p) => [p, a.pose[p] + (b.pose[p] - a.pose[p]) * e]));
          break;
        }
      }
    }
    const fl = effect.float;
    if (fl) {
      const w = floatWeight(effect, L, T);
      const phase = 2 * Math.PI * (T - (effect.edges ? edgeRamp(L) : 0)) / fl.period;
      pose.rx = pose.rx + fl.rx * Math.cos(phase) * w;
      pose.ry = pose.ry + fl.ry * Math.sin(phase) * w;
    }
    return pose;
  }

  /** 圓角與陰影的強度 0～1：edges 開時頭尾 ramp 內線性 0→1、1→0，中段 1；edges 關恆為 1（同引擎 edge_weight）。 */
  function edgeWeight(effect, L, T) {
    if (!effect.edges) return 1;
    const r = edgeRamp(L);
    if (r <= 0) return 1;
    return Math.min(1, Math.max(0, T / r)) * Math.min(1, Math.max(0, (L - T) / r));
  }

  /** 四角的 [螢幕 x, 螢幕 y, Z]。 */
  function project(pose, w, h, pad) {
    const rz = rad(pose.rz), rx = rad(pose.rx), ry = rad(pose.ry);
    const f = w / 2 * D0, d = D0 / pose.size;
    const hw = w / (w - 2 * pad), hh = h / w * h / (h - 2 * pad);
    const tx = pose.px * 2 / pose.size, ty = pose.py * 2 * (h / w) / pose.size;
    return [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]].map(([lx, ly]) => {
      const x1 = lx * Math.cos(rz) - ly * Math.sin(rz), y1 = lx * Math.sin(rz) + ly * Math.cos(rz);
      const y2 = y1 * Math.cos(rx), z2 = y1 * Math.sin(rx);
      const x3 = x1 * Math.cos(ry) + z2 * Math.sin(ry), z3 = -x1 * Math.sin(ry) + z2 * Math.cos(ry);
      const X = x3 + tx, Y = y2 + ty, Z = z3 + d;
      return [w / 2 + f * X / Z, h / 2 + f * Y / Z, Z];
    });
  }

  /** 四角投影到畫面上的像素座標 [[x, y]]×4。pad：輸出用 PAD，預覽用 0。 */
  const corners = (pose, w, h, pad = 0) => project(pose, w, h, pad).map(([x, y]) => [x, y]);

  /** 姿勢可不可以用：範圍、離鏡頭夠遠、投影點不離畫面太遠、凸四邊形。 */
  function poseValid(pose, w, h) {
    for (const [k, [lo, hi]] of Object.entries(RANGES)) {
      const v = pose[k];
      if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) return false;
    }
    const pts = project(pose, w, h, 0);
    if (pts.some(([, , z]) => z < MIN_Z)) return false;
    if (pts.some(([x, y]) => Math.abs(x - w / 2) > MAX_SPREAD * w || Math.abs(y - h / 2) > MAX_SPREAD * h)) return false;
    const ring = [pts[0], pts[1], pts[3], pts[2]];
    const cross = ring.map((p, i) => {
      const q = ring[(i + 1) % 4], r = ring[(i + 2) % 4];
      return (q[0] - p[0]) * (r[1] - q[1]) - (q[1] - p[1]) * (r[0] - q[0]);
    });
    return cross.every((c) => c > 0) || cross.every((c) => c < 0);
  }

  /** 來源矩形 (0,0)-(w,h) → 四角 dst 的 3×3 投影矩陣（h33=1），列優先（同引擎的高斯消去）。 */
  function homography(dst, w, h) {
    const src = [[0, 0], [w, 0], [0, h], [w, h]];
    const rows = [];
    src.forEach(([x, y], i) => {
      const [u, v] = dst[i];
      rows.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      rows.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    });
    const n = 8;
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(rows[r][c]) > Math.abs(rows[p][c])) p = r;
      [rows[c], rows[p]] = [rows[p], rows[c]];
      for (let r = 0; r < n; r++) {
        if (r !== c && rows[r][c]) {
          const k = rows[r][c] / rows[c][c];
          rows[r] = rows[r].map((a, j) => a - k * rows[c][j]);
        }
      }
    }
    const hv = [...Array.from({length: n}, (_, i) => rows[i][8] / rows[i][i]), 1];
    return [hv.slice(0, 3), hv.slice(3, 6), hv.slice(6, 9)];
  }

  /** CSS transform 字串：把 (0,0)-(w,h) 的元素（transform-origin: 0 0）映射到四角。 */
  function cssMatrix3d(dst, w, h) {
    const m = homography(dst, w, h);
    const v = [m[0][0], m[1][0], 0, m[2][0], m[0][1], m[1][1], 0, m[2][1], 0, 0, 1, 0, m[0][2], m[1][2], 0, m[2][2]];
    return `matrix3d(${v.map((x) => +x.toPrecision(12)).join(',')})`;
  }

  return {FOV_DEG, D0, PAD, EDGE_RAMP, MAX_KEYS, MIN_Z, MAX_SPREAD, SHADOW_DY, SHADOW_SIGMA, FLAT, PARAMS, RANGES, FLOAT_RANGES, EASES,
    ease, edgeRamp, keyTimes, resolvedTimes, poseAt, edgeWeight, corners, poseValid, pathValid, homography, cssMatrix3d};
})();

// 瀏覽器：傳統 script，PLANE3D 在全域（index.html 於 plane3d.js 之前載入）。Node：scripts/plane3d-math-parity.js 以 vm 載入。
if (typeof module !== 'undefined' && module.exports) module.exports = PLANE3D;
