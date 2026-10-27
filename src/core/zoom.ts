// 局部放大（spec §5.19，P1-2）：片段的縮放與平移關鍵幀（Clip.zoomKeys，素材時間）。純函式，預覽與匯出共用（D24）：
// framePlan 用 zoomAt 算出每格的倍率與中心，再用 zoomCrop 換成要取的畫面範圍，合成器只改貼圖座標。
// 關鍵幀之間用 smoothstep 緩動、倍率取對數內插（1→4 倍時看起來等速）；第一個關鍵幀前與最後一個之後各 0.5 秒
// （素材時間；片段 2 倍速時在時間軸上是 0.25 秒）從原畫面推進、退回原畫面；倍率 1 的關鍵幀結束一段放大。
import { produce } from "immer";
import type { Clip, Project, Rect, Seconds, ZoomKey } from "./model";

/** 頭尾推進／退回的時間（素材秒） */
export const ZOOM_RAMP: Seconds = 0.5;
/** 倍率範圍 */
const MIN_SCALE = 1;
const MAX_SCALE = 4;

/** 某一格的放大狀態 */
export interface Zoom {
  scale: number;
  cx: number;
  cy: number;
}

/** 原畫面 */
const IDENTITY: Zoom = { scale: 1, cx: 0.5, cy: 0.5 };

/** 平滑（頭尾慢、中間快） */
function smooth(u: number): number {
  const x = Math.min(1, Math.max(0, u));
  return x * x * (3 - 2 * x);
}

/** 兩個放大狀態之間內插（倍率取對數） */
function lerp(a: Zoom, b: Zoom, u: number): Zoom {
  const k = smooth(u);
  return {
    scale: Math.exp(Math.log(a.scale) + (Math.log(b.scale) - Math.log(a.scale)) * k),
    cx: a.cx + (b.cx - a.cx) * k,
    cy: a.cy + (b.cy - a.cy) * k,
  };
}

/** 關鍵幀 → 放大狀態（倍率夾在 1～4） */
function keyZoom(k: ZoomKey): Zoom {
  return { scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, k.scale)), cx: k.cx, cy: k.cy };
}

/** 片段在素材時間 s 的倍率與中心 */
export function zoomAt(clip: Clip, s: Seconds): Zoom {
  const keys = [...(clip.zoomKeys ?? [])].sort((a, b) => a.src - b.src);
  if (!keys.length) return IDENTITY;
  // 第一個放大的關鍵幀之前：前 0.5 秒從原畫面推進（中心直接對著目標）
  const first = keys[0];
  if (s <= first.src) {
    if (first.scale <= MIN_SCALE || s <= first.src - ZOOM_RAMP) return IDENTITY;
    const target = keyZoom(first);
    return lerp({ ...target, scale: 1 }, target, (s - (first.src - ZOOM_RAMP)) / ZOOM_RAMP);
  }
  // 關鍵幀之間：緩動；倍率 1 的關鍵幀之後到下一個放大的關鍵幀前 0.5 秒是原畫面
  for (let i = 0; i + 1 < keys.length; i++) {
    const a = keys[i];
    const b = keys[i + 1];
    if (s > b.src) continue;
    if (a.scale <= MIN_SCALE) {
      if (b.scale <= MIN_SCALE || s <= b.src - ZOOM_RAMP) return IDENTITY;
      const target = keyZoom(b);
      return lerp({ ...target, scale: 1 }, target, (s - Math.max(a.src, b.src - ZOOM_RAMP)) / Math.min(ZOOM_RAMP, b.src - a.src));
    }
    return lerp(keyZoom(a), keyZoom(b), (s - a.src) / Math.max(1e-6, b.src - a.src));
  }
  // 最後一個關鍵幀之後：0.5 秒退回原畫面
  const last = keys[keys.length - 1];
  if (last.scale <= MIN_SCALE || s >= last.src + ZOOM_RAMP) return IDENTITY;
  const from = keyZoom(last);
  return lerp(from, { ...from, scale: 1 }, (s - last.src) / ZOOM_RAMP);
}

/** 放大狀態 → 要取的畫面範圍（0～1；寬高 1/倍率，比例和畫面一樣；超出畫面就夾回來） */
export function zoomCrop(z: Zoom): Rect {
  const w = 1 / Math.min(MAX_SCALE, Math.max(MIN_SCALE, z.scale));
  const clamp = (c: number) => Math.min(1 - w, Math.max(0, c - w / 2));
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return { x: r(clamp(z.cx)), y: r(clamp(z.cy)), w: r(w), h: r(w) };
}

/** 換掉片段的整組放大關鍵幀（依素材時間排序） */
export function setClipZoomKeys(project: Project, clipId: string, keys: ZoomKey[]): Project {
  if (!project.clips.some((c) => c.id === clipId)) return project;
  return produce(project, (draft) => {
    draft.clips.find((c) => c.id === clipId)!.zoomKeys = [...keys].sort((a, b) => a.src - b.src);
  });
}

/** 單拖一次框時，放大停留幾秒（開發者 2026-10-28 選定） */
export const FIRST_HOLD: Seconds = 2;

/**
 * 在預覽拖框加一個關鍵幀：片段還沒有關鍵幀時，同時建 2 秒後同一個框（不超過素材範圍的結尾 srcOut），單拖一次就會停留；
 * 已經有了就和差不到一格（1/30 秒）的關鍵幀取代，否則依時間插入。
 */
export function insertZoomKey(keys: ZoomKey[], key: ZoomKey, srcOut: Seconds): ZoomKey[] {
  if (!keys.length) {
    const hold = Math.min(srcOut, key.src + FIRST_HOLD);
    return hold > key.src ? [key, { ...key, src: hold }] : [key];
  }
  const rest = keys.filter((k) => Math.abs(k.src - key.src) >= 1 / 30);
  return [...rest, key].sort((a, b) => a.src - b.src);
}
