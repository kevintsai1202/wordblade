// SAM 結果 → 遮罩物件（spec §5.3）：照搬 transcript-review 的換鏡頭判斷（face_track._is_cut）、拆段（face_matte.split_parts）、
// 跨輪接續（face_matte.link_faces）與取樣挑選（face_matte.sample_of），改成以素材時間（秒）計。
// 一次請求（pass）＝一支上傳的小檔：第 k 格 ↔ 素材時間 start + k ÷ fps。範圍長時分成多次請求，相鄰兩次重疊一格，用那一格的框接起來。
import type { MaskObject, MaskSample } from "../core/model";
import type { SamFrame } from "./stream";

/** 差異至少這麼大才可能是換鏡頭（畫面幾乎不動時跳出小視窗不算） */
const CUT_DIFF = 12;
/** ……而且是前後 CUT_WINDOW 格差異中位數（取較大的那邊）的這麼多倍 */
const CUT_RATIO = 3;
/** 前後各看幾格 */
const CUT_WINDOW = 6;
/** 同一個 id 消失超過這麼久就拆成兩個物件 */
const MAX_GAP_SECONDS = 1.0;
/** 相鄰兩次出現的中心距離超過「較寬的框寬 × 這個倍數」就拆開…… */
const JUMP_RATIO = 1.0;
/** ……中間沒看到 g − 1 張時容許值乘 1 + 0.25 × (g − 1)…… */
const JUMP_GROWTH = 0.25;
/** ……最多兩倍 */
const JUMP_MAX_FACTOR = 2.0;
/** 相鄰兩次出現的框寬比例超過這個倍數就拆開 */
const SIZE_JUMP = 1.6;
/** 跨輪接續：兩個框的 IoU 至少這麼多才算同一個物件 */
const LINK_IOU = 0.3;
/** 時間比較的容許誤差 */
const EPS = 1e-6;

/** 一次 SAM 請求的結果 */
export interface SamPass {
  /** 小檔第 0 格的素材時間 */
  start: number;
  /** 取樣率（每秒幾格） */
  fps: number;
  /** 各格的素材時間（有就用它，比 start + k ÷ fps 準：來源格率不是取樣率的整數倍時會漂） */
  times?: number[];
  /** 小檔寬高（記錄沒帶 w／h 時才用；SAM 的記錄都帶自己看到的畫面寬高） */
  clipW: number;
  clipH: number;
  frames: SamFrame[];
  /** 換鏡頭：新鏡頭的第一格（小檔格序，遞增；cutsFromDiffs） */
  cuts: number[];
}

/** 一段：同一次請求裡同一個 SAM id、沒有被拆開的連續出現 */
export interface Part {
  pass: number;
  oid: number;
  /** 取樣、框、SAM 回報的畫面寬高（正規化用它，不用我們以為上傳的尺寸）、遮罩 */
  boxes: { sample: number; x1: number; y1: number; x2: number; y2: number; w: number; h: number; mask: SamFrame["records"][number]["mask"] }[];
}

/** 中位數 */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 逐格差異 → 換鏡頭（新鏡頭的第一格）。d[0] 是起點（沒有前一格）；第 i 格的 d ≥ 12 且 ≥ 3 × 前後各 6 格中位數較大的那個才算，
 * 只有一邊有資料時用那一邊，兩邊都沒有時只看 12。閃光（連續兩格突增）算兩次。
 */
export function cutsFromDiffs(d: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < d.length; i++) {
    if (d[i] < CUT_DIFF) continue;
    const sides = [d.slice(Math.max(1, i - CUT_WINDOW), i), d.slice(i + 1, i + 1 + CUT_WINDOW)].filter((p) => p.length).map(median);
    if (!sides.length || d[i] >= CUT_RATIO * Math.max(...sides)) out.push(i);
  }
  return out;
}

/** 相鄰兩格的平均像素差（RGBA 或 RGB 都可，只要每格長度相同）：0～255 */
export function frameDiffs(frames: Uint8Array[]): number[] {
  return frames.map((f, i) => {
    if (i === 0) return 0;
    const prev = frames[i - 1];
    let sum = 0;
    for (let k = 0; k < f.length; k++) sum += Math.abs(f[k] - prev[k]);
    return sum / f.length;
  });
}

/** 框 → 中心與寬 */
function centerWidth(b: { x1: number; y1: number; x2: number; y2: number }) {
  return { cx: (b.x1 + b.x2) / 2, cy: (b.y1 + b.y2) / 2, w: b.x2 - b.x1 };
}

/** 兩個框的 IoU */
function iou(a: { x1: number; y1: number; x2: number; y2: number }, b: { x1: number; y1: number; x2: number; y2: number }): number {
  const ix = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
  const iy = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
  const inter = ix * iy;
  const union = (a.x2 - a.x1) * (a.y2 - a.y1) + (b.x2 - b.x1) * (b.y2 - b.y1) - inter;
  return union > 0 ? inter / union : 0;
}

/** 同一個 id 前後兩次出現之間要不要拆開：消失超過 1 秒、中心跳太遠、框寬比例太大 */
function breaks(prevSample: number, prev: Part["boxes"][number], sample: number, box: Part["boxes"][number], fps: number): boolean {
  const g = sample - prevSample;
  if (g - 1 > Math.round(MAX_GAP_SECONDS * fps)) return true;
  const a = centerWidth(prev);
  const b = centerWidth(box);
  const wide = Math.max(a.w, b.w);
  if (Math.hypot(b.cx - a.cx, b.cy - a.cy) > JUMP_RATIO * wide * Math.min(JUMP_MAX_FACTOR, 1 + JUMP_GROWTH * (g - 1))) return true;
  return wide > SIZE_JUMP * Math.max(1e-6, Math.min(a.w, b.w));
}

/** 一次請求的結果 → 段（同一個 id 有換鏡頭或 breaks 就開新的一段），依第一次出現排序 */
export function buildParts(pass: SamPass, passNo = 0): Part[] {
  /** 格序在第幾個鏡頭 */
  const shot = (s: number) => pass.cuts.filter((c) => c <= s).length;
  const byId = new Map<number, Part["boxes"]>();
  for (const f of [...pass.frames].sort((a, b) => a.frame - b.frame)) {
    for (const r of f.records) {
      if (!byId.has(r.id)) byId.set(r.id, []);
      byId.get(r.id)!.push({ sample: f.frame, x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2, w: r.w || pass.clipW, h: r.h || pass.clipH, mask: r.mask });
    }
  }
  const parts: Part[] = [];
  for (const [oid, seen] of byId) {
    let current: Part | null = null;
    for (const box of seen) {
      const last = current?.boxes[current.boxes.length - 1];
      if (!current || !last || shot(last.sample) !== shot(box.sample) || breaks(last.sample, last, box.sample, box, pass.fps)) {
        current = { pass: passNo, oid, boxes: [] };
        parts.push(current);
      }
      current.boxes.push(box);
    }
  }
  return parts.sort((a, b) => a.boxes[0].sample - b.boxes[0].sample || a.boxes[0].x1 - b.boxes[0].x1 || a.oid - b.oid);
}

/** 接好的物件：各段與它們所屬的請求 */
export interface LinkedObject {
  parts: { pass: SamPass; part: Part }[];
}

/**
 * 各次請求 → 物件：第 k 次請求的第 0 格（和前一次請求的最後一格重疊）有出現的段，和更早的請求在同一時間出現的段比框的 IoU，
 * ≥ 0.3 的依 IoU 由高到低一對一接起來（併查集）。換鏡頭切開的段不會被接（重疊那格不在同一個鏡頭時本來就不會重疊）。
 */
export function linkPasses(passes: SamPass[]): LinkedObject[] {
  const items: { pass: SamPass; passNo: number; part: Part }[] = passes.flatMap((pass, passNo) => buildParts(pass, passNo).map((part) => ({ pass, passNo, part })));
  const parent = items.map((_, i) => i);
  const root = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  /** 某段在素材時間 t 的框（座標正規化，跨請求才比得了） */
  const boxAt = (it: (typeof items)[number], t: number) => {
    const b = it.part.boxes.find((x) => Math.abs(sampleTime(it.pass, x.sample) - t) < 1 / (2 * it.pass.fps));
    return b && { x1: b.x1 / b.w, y1: b.y1 / b.h, x2: b.x2 / b.w, y2: b.y2 / b.h };
  };
  for (let k = 1; k < passes.length; k++) {
    const t = passes[k].start;
    const here = items.map((it, i) => ({ i, it, box: it.passNo <= k ? boxAt(it, t) : undefined })).filter((x) => x.box);
    const fresh = here.filter((x) => x.it.passNo === k);
    const old = here.filter((x) => x.it.passNo < k);
    const pairs = fresh.flatMap((a) => old.map((b) => ({ score: iou(a.box!, b.box!), i: a.i, j: b.i }))).sort((a, b) => b.score - a.score);
    const linked = new Set<number>();
    const taken = new Set<number>();
    for (const { score, i, j } of pairs) {
      if (score < LINK_IOU) break;
      const rj = root(j);
      if (linked.has(i) || taken.has(rj) || root(i) === rj) continue;
      linked.add(i);
      taken.add(rj);
      parent[root(i)] = rj;
    }
  }
  const groups = new Map<number, LinkedObject>();
  items.forEach((it, i) => {
    const r = root(i);
    if (!groups.has(r)) groups.set(r, { parts: [] });
    groups.get(r)!.parts.push({ pass: it.pass, part: it.part });
  });
  return [...groups.values()];
}

/** 第 k 格的素材時間 */
export function sampleTime(pass: SamPass, k: number): number {
  return pass.times?.[k] ?? pass.start + k / pass.fps;
}

/** 時間取到微秒，避免 0.1 + 0.2 這類誤差 */
const round6 = (t: number) => Math.round(t * 1e6) / 1e6;

/**
 * 接好的物件 → 專案的遮罩物件：時間換成素材時間、位置正規化；同一時間有兩個取樣（請求重疊那格）時留後面那次請求的。
 * 依第一次出現的時間、再依框的左緣排序，標籤「prompt 1、prompt 2…」。效果預設馬賽克、外擴 10%。
 */
export function toMaskObjects(objects: LinkedObject[], opts: { mediaId: string; prompt: string; idPrefix: string }): MaskObject[] {
  const built = objects.map((obj) => {
    const byTime = new Map<number, MaskSample>();
    for (const { pass, part } of obj.parts) {
      for (const b of part.boxes) {
        const t = round6(sampleTime(pass, b.sample));
        const m = b.mask;
        byTime.set(t, {
          t,
          box: [b.x1 / b.w, b.y1 / b.h, b.x2 / b.w, b.y2 / b.h],
          mask: m ? { x: (b.x1 + m.x) / b.w, y: (b.y1 + m.y) / b.h, w: m.w / b.w, h: m.h / b.h, cols: m.w, rows: m.h, payload: m.payload } : null,
        });
      }
    }
    const samples = [...byTime.values()].sort((a, b) => a.t - b.t);
    return { samples, interval: 1 / obj.parts[0].pass.fps };
  });
  built.sort((a, b) => a.samples[0].t - b.samples[0].t || a.samples[0].box[0] - b.samples[0].box[0]);
  return built.map((b, n) => ({
    id: `${opts.idPrefix}-${n + 1}`, mediaId: opts.mediaId, prompt: opts.prompt, label: `${opts.prompt} ${n + 1}`,
    samples: b.samples, interval: b.interval, effect: { kind: "mosaic", strength: 24 }, expand: 10, enabled: true,
  }));
}

/** 素材時間 t 用哪個取樣：最近的一張（取樣之間形狀不動）；第一張之前半格、最後一張之後一格以外沒有 */
export function activeSample(obj: MaskObject, t: number): MaskSample | null {
  const s = obj.samples;
  if (!s.length || t < s[0].t - obj.interval / 2 - EPS || t > s[s.length - 1].t + obj.interval + EPS) return null;
  let lo = 0;
  let hi = s.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (s[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  return lo > 0 && t - s[lo - 1].t <= s[lo].t - t ? s[lo - 1] : s[lo];
}
