// 局部放大（spec §5.19、D38，照字導字演）：一段放大是素材時間的區段 [start, end]，固定框寬 w（倍率 1/w），
// 框中心沿路徑點移動。數學照搬原專案 backend/zoom_math.py（預覽與成品一致）：
// - 頭尾緩動固定 1 秒（區段短於 2 秒取一半），ease-in-out quad；
// - 路徑：第一點前與最後一點後停住，兩點相同停住、不同時 ease 移動；
// - 倍率 S＝1＋(1/w−1)·p，原專案的平移 −(c−0.5)·(1/w)·p 換算成「畫面中央看到的素材位置」＝0.5＋(c−0.5)·(1/w)·p／S。
// 純函式，Vitest 測（照搬原專案的測試）；framePlan 用 zoomState＋zoomCrop 算每格要取的畫面範圍，合成器只改貼圖座標。
import { produce } from "immer";
import type { Project, Rect, Seconds, ZoomPoint, ZoomRegion } from "./model";
import { clipEnd, timelineToSource } from "./timeline";

/** 框寬下限（最大 4 倍） */
export const MIN_W = 0.25;

/** 某一格的放大狀態 */
export interface Zoom {
  scale: number;
  cx: number;
  cy: number;
}

/** 原畫面 */
const IDENTITY: Zoom = { scale: 1, cx: 0.5, cy: 0.5 };

/** 頭尾緩動長度（秒）：固定 1 秒；區段短於 2 秒時取一半 */
export function rampSeconds(start: Seconds, end: Seconds): Seconds {
  return Math.min(1, (end - start) / 2);
}

/** ease-in-out quad，u ∈ [0,1] */
export function ease(u: number): number {
  const x = Math.min(1, Math.max(0, u));
  return x < 0.5 ? 2 * x * x : 1 - (-2 * x + 2) ** 2 / 2;
}

/** 素材時間 s 的放大進度 0～1：起點後 ramp 秒內漸入、終點前 ramp 秒漸出、中段 1、區段外 0 */
export function progress(s: Seconds, start: Seconds, end: Seconds, ramp: Seconds): number {
  if (s < start || s > end) return 0;
  if (ramp <= 0) return 1;
  if (s < start + ramp) return ease((s - start) / ramp);
  if (s > end - ramp) return ease((end - s) / ramp);
  return 1;
}

/** 素材時間 s 的框中心：第一點前／最後一點後停住；兩點之間位置不同時 ease 移動、相同時停住 */
export function centerAt(path: ZoomPoint[], s: Seconds): { cx: number; cy: number } {
  const first = path[0];
  const last = path[path.length - 1];
  if (s <= first.src) return { cx: first.cx, cy: first.cy };
  if (s >= last.src) return { cx: last.cx, cy: last.cy };
  for (let i = 0; i + 1 < path.length; i++) {
    const [a, b] = [path[i], path[i + 1]];
    if (a.src <= s && s < b.src) {
      const u = ease((s - a.src) / (b.src - a.src));
      return { cx: a.cx + (b.cx - a.cx) * u, cy: a.cy + (b.cy - a.cy) * u };
    }
  }
  return { cx: last.cx, cy: last.cy };
}

/** 一段放大在素材時間 s 的倍率與畫面中央看到的素材位置 */
export function zoomState(zoom: ZoomRegion, s: Seconds): Zoom {
  const p = progress(s, zoom.start, zoom.end, rampSeconds(zoom.start, zoom.end));
  if (p <= 0) return IDENTITY;
  const full = 1 / Math.max(MIN_W, Math.min(1, zoom.w));
  const scale = 1 + (full - 1) * p;
  const c = centerAt(zoom.path, s);
  return { scale, cx: 0.5 + ((c.cx - 0.5) * full * p) / scale, cy: 0.5 + ((c.cy - 0.5) * full * p) / scale };
}

/** 放大狀態 → 要取的畫面範圍（0～1；寬高 1/倍率，比例和畫面一樣；超出畫面就夾回來） */
export function zoomCrop(z: Zoom): Rect {
  const w = 1 / Math.max(1, Math.min(1 / MIN_W, z.scale));
  const clamp = (c: number) => Math.min(1 - w, Math.max(0, c - w / 2));
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { x: r(clamp(z.cx)), y: r(clamp(z.cy)), w: r(w), h: r(w) };
}

/** 框中心夾在框不會超出畫面的範圍 */
export function clampCenter(c: number, w: number): number {
  return Math.min(1 - w / 2, Math.max(w / 2, c));
}

/**
 * 時間軸範圍 → 新的放大區段：取範圍起點所在的 V1 片段，換成那支素材的時間（超出這個片段的部分夾掉）；
 * 預設框寬 0.5（2 倍）、一個路徑點在畫面中央。起點不在 V1 片段上回 null。
 */
export function zoomFromRange(project: Project, range: { start: Seconds; end: Seconds }, id: string): ZoomRegion | null {
  const v1 = project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  const clip = project.clips.find((c) => c.trackId === v1 && !c.freeze && c.start <= range.start && range.start < clipEnd(c));
  if (!clip) return null;
  const start = timelineToSource(clip, range.start);
  const end = timelineToSource(clip, Math.min(range.end, clipEnd(clip)));
  if (end - start < 0.1) return null;
  return { id, mediaId: clip.mediaId, start, end: Math.min(end, clip.srcOut), w: 0.5, path: [{ src: start, cx: 0.5, cy: 0.5 }], enabled: true };
}

/** 平移整段（起訖與所有路徑點一起），夾在 [lo, hi]（片段的素材範圍）內 */
export function moveZoom(zoom: ZoomRegion, ds: Seconds, lo: Seconds, hi: Seconds): ZoomRegion {
  const d = Math.min(hi - zoom.end, Math.max(lo - zoom.start, ds));
  return { ...zoom, start: zoom.start + d, end: zoom.end + d, path: zoom.path.map((p) => ({ ...p, src: p.src + d })) };
}

/** 修邊：改起點或終點（至少留 0.2 秒、夾在 [lo, hi]），路徑點夾回區段內 */
export function trimZoom(zoom: ZoomRegion, edge: "start" | "end", s: Seconds, lo: Seconds, hi: Seconds): ZoomRegion {
  const start = edge === "start" ? Math.min(zoom.end - 0.2, Math.max(lo, s)) : zoom.start;
  const end = edge === "end" ? Math.max(zoom.start + 0.2, Math.min(hi, s)) : zoom.end;
  return { ...zoom, start, end, path: zoom.path.map((p) => ({ ...p, src: Math.min(end, Math.max(start, p.src)) })) };
}

/** 新增一段放大 */
export function addZoom(project: Project, zoom: ZoomRegion): Project {
  return produce(project, (draft) => { draft.zooms = [...(draft.zooms ?? []), zoom]; });
}

/** 換掉一段放大（依 id；路徑點依時間排序） */
export function setZoom(project: Project, zoom: ZoomRegion): Project {
  if (!project.zooms?.some((z) => z.id === zoom.id)) return project;
  return produce(project, (draft) => {
    draft.zooms = draft.zooms!.map((z) => (z.id === zoom.id ? { ...zoom, path: [...zoom.path].sort((a, b) => a.src - b.src) } : z));
  });
}

/** 刪掉一段放大 */
export function deleteZoom(project: Project, zoomId: string): Project {
  if (!project.zooms?.some((z) => z.id === zoomId)) return project;
  return produce(project, (draft) => { draft.zooms = draft.zooms!.filter((z) => z.id !== zoomId); });
}
