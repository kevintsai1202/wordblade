// 片段變速（spec §5.20，P1-6）：0.25～4 倍；畫面由合成器依變速換算素材時間（timelineToSource），
// 聲音保持音高（預覽 preservesPitch、匯出 WSOLA）。這裡只管資料：連動片段一起變速、時間軸跟著挪。
import { produce } from "immer";
import type { Project } from "./model";
import { clampFades, clipEnd, layoutV1Draft } from "./timeline";
import { roundTime } from "./time";

/** 倍數範圍 */
export const MIN_SPEED = 0.25;
export const MAX_SPEED = 4;
/** 變速後片段至少這麼長（秒；太快時倍數就夾在這裡） */
const MIN_LENGTH = 0.1;

/** 兩個時間（秒）視為相同 */
const same = (a: number, b: number) => Math.abs(a - b) < 1e-3;

/**
 * 設定片段的倍數。連動片段（其他軌道上同一支素材、同起點、同素材範圍的片段，通常是 A1 對白）一起變速。
 * 連動的片段有在 V1 上時：V1 重排；其他未鎖定軌道上「在它原本結束點之後開始」的片段、特效與時間軸定位點平移同樣距離，
 * 跨在中間的（例如配樂、蓋過接點的特效）不剪不動（開發者 2026-10-28 選定）。局部放大與詞用素材時間記，不必動。
 * 定格片段不變。
 */
export function setClipSpeed(project: Project, clipId: string, speed: number): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || clip.freeze) return project;
  // 夾在 0.25～4、取到小數兩位；太快會讓片段短於 0.1 秒就再放慢
  let s = Math.round(Math.min(MAX_SPEED, Math.max(MIN_SPEED, speed)) * 100) / 100;
  const span = clip.srcOut - clip.srcIn;
  if (span / s < MIN_LENGTH) s = Math.max(MIN_SPEED, Math.floor((span / MIN_LENGTH) * 100) / 100);
  if (s === clip.speed) return project;
  const linked = project.clips.filter((c) => c.id === clip.id || (!c.freeze && c.mediaId === clip.mediaId && same(c.start, clip.start) && same(c.srcIn, clip.srcIn) && same(c.srcOut, clip.srcOut)));
  const ids = new Set(linked.map((c) => c.id));
  const v1 = project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  const v1Member = linked.find((c) => c.trackId === v1);
  const oldEnd = v1Member ? clipEnd(v1Member) : 0;
  return produce(project, (draft) => {
    for (const c of draft.clips) {
      if (!ids.has(c.id)) continue;
      c.speed = s;
      clampFades(c);
    }
    if (!v1Member) return;
    const newEnd = clipEnd(draft.clips.find((c) => c.id === v1Member.id)!);
    const delta = roundTime(newEnd - oldEnd);
    layoutV1Draft(draft);
    if (delta === 0) return;
    const locked = new Set(draft.tracks.filter((t) => t.locked).map((t) => t.id));
    for (const c of draft.clips) {
      if (c.trackId === v1 || ids.has(c.id) || locked.has(c.trackId) || c.start < oldEnd - 1e-6) continue;
      c.start = roundTime(c.start + delta);
    }
    for (const e of draft.effects) {
      if (e.start < oldEnd - 1e-6) continue;
      e.start = roundTime(e.start + delta);
      e.end = roundTime(e.end + delta);
    }
    for (const a of draft.anchors) if (a.time !== undefined && a.time >= oldEnd - 1e-6) a.time = roundTime(a.time + delta);
  });
}
