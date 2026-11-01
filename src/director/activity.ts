// 畫面變化偵測（docs/plan-10-29-director2.md §4）：比對前後兩格的亮度，找出「正在打字、終端機印出結果」這種局部變化的區域與時間，
// 送給 AI 導演（Spark 確認那是什麼、Wonder 決定要不要放大）；放大的路徑跟著變化區的中心走，所以會對準正在打字的地方。
// 整片在變（捲動、換畫面）不算。純函式（可測）；取畫面在 sampleLuma（瀏覽器）。
import type { Seconds, ZoomPoint } from "../core/model";

/** 一格的亮度（寬 × 高，一個像素一個位元組） */
export interface LumaFrame {
  t: Seconds;
  width: number;
  height: number;
  luma: Uint8Array;
}

/** 一個活動區：時間、外框聯集（0～1）、每次變化的中心 */
export interface Activity {
  id: string;
  start: Seconds;
  end: Seconds;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 每次變化的中心與大小（0～1） */
  path: { t: Seconds; cx: number; cy: number; w: number; h: number }[];
}

/** 比對用的格子數（橫 × 直） */
const GRID_X = 32;
const GRID_Y = 18;
/** 亮度差多少算變了 */
const PIXEL_DIFF = 24;
/** 一個格子裡至少幾個像素變了才算這格有變化 */
const CELL_PIXELS = 3;
/** 變化的格子超過這個比例 → 整片在變（捲動、換畫面），不算活動 */
const GLOBAL_CHANGE = 0.35;
/** 兩次變化相隔不超過幾秒算同一個活動 */
const JOIN_GAP: Seconds = 2.5;
/** 兩次變化的外框（各往外擴這麼多）有重疊才算同一處 */
const JOIN_PAD = 0.1;

/** 一次變化：時間（後一格）、外框 */
interface Change {
  from: Seconds;
  t: Seconds;
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 前後兩格的變化外框（0～1）；沒有變化回 null，整片在變回 "global" */
function diff(a: LumaFrame, b: LumaFrame): Change | "global" | null {
  const { width: W, height: H } = b;
  const counts = new Uint16Array(GRID_X * GRID_Y);
  for (let y = 0; y < H; y++) {
    const gy = Math.min(GRID_Y - 1, Math.floor((y * GRID_Y) / H));
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (Math.abs(a.luma[i] - b.luma[i]) > PIXEL_DIFF) counts[gy * GRID_X + Math.min(GRID_X - 1, Math.floor((x * GRID_X) / W))]++;
    }
  }
  // 有變化的格子；整片在變就不算
  const on = new Uint8Array(GRID_X * GRID_Y);
  let n = 0;
  for (let k = 0; k < on.length; k++) if (counts[k] >= CELL_PIXELS) { on[k] = 1; n++; }
  if (!n) return null;
  if (n / (GRID_X * GRID_Y) > GLOBAL_CHANGE) return "global";
  // 只取最大的一塊相連區（相隔一格也算相連）：分頁列、側邊欄、游標同時在變時，對準變最多的那裡
  const seen = new Uint8Array(on.length);
  let best: number[] = [];
  for (let k = 0; k < on.length; k++) {
    if (!on[k] || seen[k]) continue;
    const comp: number[] = [];
    const stack = [k];
    seen[k] = 1;
    while (stack.length) {
      const c = stack.pop()!;
      comp.push(c);
      const cx = c % GRID_X;
      const cy = Math.floor(c / GRID_X);
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const x = cx + dx;
        const y = cy + dy;
        if (x < 0 || y < 0 || x >= GRID_X || y >= GRID_Y) continue;
        const j = y * GRID_X + x;
        if (on[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (comp.length > best.length) best = comp;
  }
  let gx0 = GRID_X;
  let gy0 = GRID_Y;
  let gx1 = -1;
  let gy1 = -1;
  for (const c of best) {
    gx0 = Math.min(gx0, c % GRID_X);
    gx1 = Math.max(gx1, c % GRID_X);
    gy0 = Math.min(gy0, Math.floor(c / GRID_X));
    gy1 = Math.max(gy1, Math.floor(c / GRID_X));
  }
  return { from: a.t, t: b.t, x0: gx0 / GRID_X, y0: gy0 / GRID_Y, x1: (gx1 + 1) / GRID_X, y1: (gy1 + 1) / GRID_Y };
}

/** 兩個外框（往外擴 pad）有沒有重疊 */
const near = (a: Change, b: { x0: number; y0: number; x1: number; y1: number }) =>
  a.x0 - JOIN_PAD < b.x1 && b.x0 - JOIN_PAD < a.x1 && a.y0 - JOIN_PAD < b.y1 && b.y0 - JOIN_PAD < a.y1;

/** 依時間排好的格子 → 活動區（同一處、相隔不超過 2.5 秒的變化接成一個；整片在變的地方切開） */
export function findActivities(frames: LumaFrame[]): Activity[] {
  const sorted = [...frames].sort((a, b) => a.t - b.t);
  /** 一個進行中的活動：變化串列與外框聯集 */
  type Open = { changes: Change[]; x0: number; y0: number; x1: number; y1: number };
  const done: Open[] = [];
  let open: Open | null = null;
  for (let i = 1; i < sorted.length; i++) {
    const c = diff(sorted[i - 1], sorted[i]);
    if (c === null) continue;
    if (c === "global") {
      if (open) done.push(open);
      open = null;
      continue;
    }
    const last = open?.changes[open.changes.length - 1];
    // 和上一次變化相近（不是和整個聯集比，免得越接越大）才接成同一個活動
    if (open && last && c.t - last.t <= JOIN_GAP && near(c, last)) {
      open.changes.push(c);
      open.x0 = Math.min(open.x0, c.x0);
      open.y0 = Math.min(open.y0, c.y0);
      open.x1 = Math.max(open.x1, c.x1);
      open.y1 = Math.max(open.y1, c.y1);
    } else {
      if (open) done.push(open);
      open = { changes: [c], x0: c.x0, y0: c.y0, x1: c.x1, y1: c.y1 };
    }
  }
  if (open) done.push(open);
  const round = (v: number) => Math.round(v * 1000) / 1000;
  const used = new Set<string>();
  return done.map((o) => {
    const first = o.changes[0];
    // 開始：變化前一格，但兩格相隔很久時最多往前推 1 秒
    const start = Math.max(first.from, first.t - 1);
    let id = `a${Math.round(start * 10)}`;
    while (used.has(id)) id += "b";
    used.add(id);
    return {
      id, start: round(start), end: round(o.changes[o.changes.length - 1].t),
      x: round(o.x0), y: round(o.y0), w: round(o.x1 - o.x0), h: round(o.y1 - o.y0),
      path: o.changes.map((c) => ({ t: c.t, cx: round((c.x0 + c.x1) / 2), cy: round((c.y0 + c.y1) / 2), w: round(c.x1 - c.x0), h: round(c.y1 - c.y0) })),
    };
  });
}

/** 夾在範圍內 */
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 一個區塊的變化要塞進框的多少比例以內（留邊） */
const BLOCK_FILL = 0.9;
/** 換區塊時移動多久（秒；前一塊固定到移動開始） */
const BLOCK_MOVE: Seconds = 0.6;

/** 一次變化的外框 */
type Box = { x0: number; y0: number; x1: number; y1: number };
const boxOf = (p: Activity["path"][number]): Box => ({ x0: p.cx - p.w / 2, y0: p.cy - p.h / 2, x1: p.cx + p.w / 2, y1: p.cy + p.h / 2 });
const union = (a: Box, b: Box): Box => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1) });
/** 外框放得進寬 w 的放大框（寬高都以畫面比例計，留邊） */
const fits = (b: Box, w: number) => b.x1 - b.x0 <= w * BLOCK_FILL && b.y1 - b.y0 <= w * BLOCK_FILL;

/**
 * 活動區 → 局部放大（ZoomRegion 的框寬與路徑；素材時間）。放大時畫面晃動會讓觀看者不舒服（2026-10-30 開發者回饋），所以框是固定的：
 * - 框寬看「每次變化」的大小（中位數，不看整段的聯集——一行一行往下打字時聯集會變成半個畫面）並留邊（0.3～0.8，倍率 1.25～3.3）。
 * - 依時間把變化分成區塊：還放得進同一個框就算同一塊；放不進、而且下一次變化也在新位置，才換區塊（只出現一次的變化當雜訊略過）。
 * - 每塊的框對準那塊所有變化的聯集中心，從開始固定到結束；換區塊時前一塊固定到移動前 0.6 秒，再移到新位置。
 * - 框夾住不超出畫面。
 */
export function zoomFromActivity(a: Activity): { w: number; path: ZoomPoint[] } {
  const pts = a.path.length ? a.path : [{ t: a.start, cx: a.x + a.w / 2, cy: a.y + a.h / 2, w: a.w, h: a.h }];
  const sizes = pts.map((p) => Math.max(p.w, p.h)).sort((x, y) => x - y);
  const w = clamp(sizes[Math.floor(sizes.length / 2)] * 1.6 + 0.12, 0.3, 0.8);
  /** 區塊：開始時間（第一次變化）、最後一次變化時間、所有變化的外框聯集 */
  const blocks: { start: Seconds; last: Seconds; box: Box }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const cur = blocks[blocks.length - 1];
    const b = boxOf(pts[i]);
    if (cur && fits(union(cur.box, b), w)) {
      cur.box = union(cur.box, b);
      cur.last = pts[i].t;
      continue;
    }
    // 放不進目前的框：下一次變化也和它在一起才換區塊，否則當雜訊
    const next = pts[i + 1];
    if (cur && next && !fits(union(b, boxOf(next)), w)) continue;
    if (cur && !next) continue;
    blocks.push({ start: pts[i].t, last: pts[i].t, box: b });
  }
  const center = (b: Box) => ({ cx: clamp((b.x0 + b.x1) / 2, w / 2, 1 - w / 2), cy: clamp((b.y0 + b.y1) / 2, w / 2, 1 - w / 2) });
  const path: ZoomPoint[] = [];
  blocks.forEach((blk, k) => {
    const c = center(blk.box);
    const from = k === 0 ? a.start : blk.start;
    const nextStart = blocks[k + 1]?.start;
    // 固定到：下一塊移動開始前（至少到這塊最後一次變化）；最後一塊固定到活動結束
    const until = nextStart === undefined ? Math.max(a.end, blk.last) : Math.max(blk.last, nextStart - BLOCK_MOVE);
    path.push({ src: from, ...c });
    if (until > from) path.push({ src: until, ...c });
  });
  return { w, path };
}

/** 從影片取一串格子的亮度（寬 320；瀏覽器）：AI 導演上傳每段之前先算那段的活動區 */
export async function sampleLuma(source: Blob | string, times: number[], width = 320): Promise<LumaFrame[]> {
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: typeof source === "string" ? new mb.UrlSource(source) : new mb.BlobSource(source), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) return [];
    const sink = new mb.CanvasSink(track, { width: Math.min(width, await track.getDisplayWidth()), poolSize: 2 });
    const out: LumaFrame[] = [];
    let k = 0;
    for await (const frame of sink.canvasesAtTimestamps(times)) {
      const t = times[k++];
      if (!frame) continue;
      const canvas = frame.canvas as OffscreenCanvas | HTMLCanvasElement;
      const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
      const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const luma = new Uint8Array(canvas.width * canvas.height);
      for (let i = 0, j = 0; i < img.data.length; i += 4, j++) luma[j] = (img.data[i] * 77 + img.data[i + 1] * 150 + img.data[i + 2] * 29) >> 8;
      out.push({ t, width: canvas.width, height: canvas.height, luma });
    }
    return out;
  } finally {
    input.dispose();
  }
}
