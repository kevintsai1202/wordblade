// 轉場（spec §5.9，P2；2026-11-02）：純函式，預覽與匯出共用。
// 不改長度：轉場放在 V1 兩段的接點 T，時間窗 [T − h, T + h)（h＝長度的一半，且不超過兩側片段長度的一半）。
// 時間窗內前一段往後延、後一段往前提早出現；延伸的素材時間超出素材就停在最後／第一格（§5.9 沒有手把時用定格補）。
import { produce } from "immer";
import type { Clip, Media, Project, Rect, Seconds, Transition, TransitionKind } from "./model";
import { clipDuration, clipEnd, timelineToSource } from "./timeline";
import { roundTime } from "./time";

/** 預設長度與上下限（秒） */
export const TRANSITION_DEFAULT: Seconds = 0.5;
export const TRANSITION_MIN: Seconds = 0.1;
export const TRANSITION_MAX: Seconds = 2;

/** 延伸超出素材結尾時，往回留多少（解碼器在素材最尾端常常取不到格） */
const TAIL_GUARD: Seconds = 0.02;

/** 一個生效中的接點 */
export interface Cut {
  transition: Transition;
  /** 接點（時間軸時間） */
  t: Seconds;
  /** 實際的半長（已依兩側片段長度縮短） */
  half: Seconds;
  prev: Clip;
  next: Clip;
}

/** V1 的片段（依起點排序） */
function v1Clips(project: Project): Clip[] {
  const v1 = [...project.tracks].filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  return project.clips.filter((c) => c.trackId === v1).sort((a, b) => a.start - b.start);
}

/** 所有找得到接點的轉場（片段被刪、移到開頭沒有前一段的不算） */
export function transitionCuts(project: Project): Cut[] {
  if (!project.transitions?.length) return [];
  const clips = v1Clips(project);
  const out: Cut[] = [];
  for (const transition of project.transitions) {
    const k = clips.findIndex((c) => c.id === transition.clipId);
    if (k <= 0) continue;
    const prev = clips[k - 1];
    const next = clips[k];
    // V1 首尾相接；接不上（有空隙）就不畫
    if (Math.abs(clipEnd(prev) - next.start) > 1e-6) continue;
    const half = Math.min(transition.duration / 2, clipDuration(prev) / 2, clipDuration(next) / 2);
    if (half <= 0) continue;
    out.push({ transition, t: next.start, half, prev, next });
  }
  return out;
}

/** 片段畫得到的時間範圍：本身的範圍，加上兩端轉場的延伸 */
export function visibleRange(cuts: Cut[], clip: Clip): { from: Seconds; to: Seconds } {
  let from = clip.start;
  let to = clipEnd(clip);
  for (const cut of cuts) {
    if (cut.next.id === clip.id) from = Math.min(from, cut.t - cut.half);
    if (cut.prev.id === clip.id) to = Math.max(to, cut.t + cut.half);
  }
  return { from, to };
}

/** 時間軸時間 t 的素材時間：延伸到片段外時照速度往外推，夾在素材範圍內（定格片段一律是定格那一格） */
export function extendedSource(clip: Clip, t: Seconds, media: Media | undefined): Seconds {
  const s = timelineToSource(clip, t);
  if (clip.freeze) return s;
  const max = media && media.duration > 0 ? Math.max(0, media.duration - TAIL_GUARD) : Infinity;
  // 片段內照原本的值（不受保護距離影響），只有延伸出去的部分才夾
  if (t >= clip.start && t < clipEnd(clip)) return s;
  return roundTime(Math.min(max, Math.max(0, s)));
}

/** 轉場在時間 t 對一個片段的影響 */
export interface TransitionLook {
  /** 前一段、後一段的透明度係數與水平位移（畫面寬的比例） */
  prev: { opacity: number; dx: number };
  next: { opacity: number; dx: number };
  /** 穿黑／白：疊在兩段之上的純色與透明度 */
  solid: { color: [number, number, number]; opacity: number } | null;
}

/**
 * 時間 t 在轉場窗內的樣子（p＝0～1 的進度）。疊放是先前一段、再後一段、最後純色；
 * 合成器是預乘 alpha 疊加，所以溶接時前一段維持 1、後一段用 p（不是兩邊各 1−p 與 p，那樣中間會變暗）。
 */
export function transitionLook(kind: TransitionKind, p: number): TransitionLook {
  const q = Math.max(0, Math.min(1, p));
  switch (kind) {
    case "dissolve":
      return { prev: { opacity: 1, dx: 0 }, next: { opacity: q, dx: 0 }, solid: null };
    case "dipBlack":
    case "dipWhite": {
      const color: [number, number, number] = kind === "dipBlack" ? [0, 0, 0] : [1, 1, 1];
      // 前半段：前一段上面的純色由 0 到 1；後半段：後一段上面的純色由 1 到 0
      return q < 0.5
        ? { prev: { opacity: 1, dx: 0 }, next: { opacity: 0, dx: 0 }, solid: { color, opacity: q * 2 } }
        : { prev: { opacity: 0, dx: 0 }, next: { opacity: 1, dx: 0 }, solid: { color, opacity: (1 - q) * 2 } };
    }
    case "pushLeft":
      return { prev: { opacity: 1, dx: -q }, next: { opacity: 1, dx: 1 - q }, solid: null };
    case "pushRight":
      return { prev: { opacity: 1, dx: q }, next: { opacity: 1, dx: q - 1 }, solid: null };
  }
}

/** 時間 t 落在哪個轉場窗裡（和進度）；不在任何窗裡回 null */
export function cutAt(cuts: Cut[], t: Seconds): { cut: Cut; p: number } | null {
  for (const cut of cuts) {
    if (t >= cut.t - cut.half && t < cut.t + cut.half) return { cut, p: (t - (cut.t - cut.half)) / (cut.half * 2) };
  }
  return null;
}

/** 框水平平移 dx（畫面寬的比例） */
export function shiftRect(rect: Rect, dx: number): Rect {
  return dx === 0 ? rect : { ...rect, x: rect.x + dx };
}

/** 設定（或拿掉）某個 V1 片段起點的轉場；kind 為 null 就拿掉。長度夾在上下限內 */
export function setTransition(project: Project, clipId: string, kind: TransitionKind | null, duration: Seconds = TRANSITION_DEFAULT): Project {
  const others = (project.transitions ?? []).filter((t) => t.clipId !== clipId);
  if (!kind) {
    if (others.length === (project.transitions ?? []).length) return project;
    return produce(project, (d) => { d.transitions = others; });
  }
  const old = project.transitions?.find((t) => t.clipId === clipId);
  const record: Transition = {
    id: old?.id ?? `tr-${clipId}`,
    clipId,
    kind,
    duration: roundTime(Math.min(TRANSITION_MAX, Math.max(TRANSITION_MIN, duration))),
  };
  return produce(project, (d) => { d.transitions = [...others, record]; });
}

/**
 * 轉場時對白的聲音（2026-11-02 補）：接點前半段前一段的對白淡出、後半段後一段的對白淡入，不再硬切。
 * 只看對白軌（role="dialogue"）上終點／起點剛好在接點的片段；配樂、音效不動。回傳 0～1 的係數。
 */
export function transitionAudioFactor(project: Project, cuts: Cut[], clip: Clip, t: Seconds): number {
  if (!cuts.length) return 1;
  const track = project.tracks.find((tr) => tr.id === clip.trackId);
  if (track?.kind !== "audio" || track.role !== "dialogue") return 1;
  let f = 1;
  for (const cut of cuts) {
    if (Math.abs(clipEnd(clip) - cut.t) < 1e-6 && t >= cut.t - cut.half && t < cut.t) f = Math.min(f, (cut.t - t) / cut.half);
    if (Math.abs(clip.start - cut.t) < 1e-6 && t >= cut.t && t < cut.t + cut.half) f = Math.min(f, (t - cut.t) / cut.half);
  }
  return Math.max(0, Math.min(1, f));
}
