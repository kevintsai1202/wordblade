// 時間軸編輯（spec §4、§5.1）：全部是「舊專案 → 新專案」的純函式，用 Immer 做結構共享（沒改到的部分在新舊狀態之間共用）。
// V1 首尾相接是「推導出來的」：每次編輯完都依順序與長度重算 V1 起點，不做累加位移，避免誤差漂移。
import { current, produce, type Draft } from "immer";
import type { Clip, Effect, Project, Seconds } from "./model";
import { roundTime } from "./time";

/** 片段最短長度（秒）；修邊不會修到比這更短 */
const MIN_CLIP: Seconds = 0.01;
/** 改字即剪時，詞的邊界前後各多剪的秒數（§5.1） */
export const WORD_PAD: Seconds = 0.05;

/** 片段在時間軸上的長度：素材長度 ÷ 速度；定格片段是 hold */
export function clipDuration(clip: Clip): Seconds {
  return clip.freeze ? clip.freeze.hold : roundTime((clip.srcOut - clip.srcIn) / clip.speed);
}

/** 片段在時間軸上的終點 */
export function clipEnd(clip: Clip): Seconds {
  return roundTime(clip.start + clipDuration(clip));
}

/** 時間軸時間 → 這個片段的素材時間（含變速；定格片段一律是定格的那一格） */
export function timelineToSource(clip: Clip, t: Seconds): Seconds {
  if (clip.freeze) return clip.freeze.at;
  return roundTime(clip.srcIn + (t - clip.start) * clip.speed);
}

/** 素材時間 → 時間軸時間；不在片段的素材範圍內（或是定格片段）回 null */
export function sourceToTimeline(clip: Clip, s: Seconds): Seconds | null {
  if (clip.freeze || s < clip.srcIn || s > clip.srcOut) return null;
  return roundTime(clip.start + (s - clip.srcIn) / clip.speed);
}

/** 主軌 V1 的軌道 id（video 軌裡 index 最小的） */
function v1TrackId(project: Project | Draft<Project>): string | undefined {
  return [...project.tracks].filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
}

/** 在草稿上依起點順序重算 V1 起點，首尾相接 */
export function layoutV1Draft(draft: Draft<Project>) {
  const v1 = v1TrackId(draft);
  let cursor = 0;
  const clips = draft.clips.filter((c) => c.trackId === v1).sort((a, b) => a.start - b.start);
  for (const clip of clips) {
    clip.start = cursor;
    cursor = roundTime(cursor + clipDuration(clip));
  }
}

/** 依順序與長度重算 V1 起點（首尾相接） */
export function layoutV1(project: Project): Project {
  return produce(project, layoutV1Draft);
}

/** 產生不重複的片段 id：原 id 加 -2、-3… */
function uniqueId(draft: Draft<Project>, base: string): string {
  const ids = new Set(draft.clips.map((c) => c.id));
  let n = 2;
  while (ids.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/** 把片段的終點改到時間軸時間 t（起點不動） */
function setClipEnd(clip: Draft<Clip>, t: Seconds) {
  if (clip.freeze) clip.freeze.hold = roundTime(t - clip.start);
  else clip.srcOut = timelineToSource(clip, t);
  clampFades(clip);
}

/** 把片段的起點改到時間軸時間 t（終點不動） */
function setClipStart(clip: Draft<Clip>, t: Seconds) {
  if (clip.freeze) clip.freeze.hold = roundTime(clipEnd(clip) - t);
  else clip.srcIn = timelineToSource(clip, t);
  clip.start = roundTime(t);
  clampFades(clip);
}

/** 淡入淡出不超過片段長度 */
export function clampFades(clip: Draft<Clip>) {
  const len = clipDuration(clip);
  clip.fadeIn = Math.min(clip.fadeIn, len);
  clip.fadeOut = Math.min(clip.fadeOut, len);
}

/** 在時間軸時間 t 把片段切成兩段，回傳後段（新片段，已加進 clips） */
function splitDraft(draft: Draft<Project>, clip: Draft<Clip>, t: Seconds): Draft<Clip> {
  const tail = structuredClone(current(clip)) as Clip;
  tail.id = uniqueId(draft, clip.id);
  const end = clipEnd(clip);
  setClipEnd(clip, t);
  draft.clips.splice(draft.clips.indexOf(clip) + 1, 0, tail);
  const tailDraft = draft.clips[draft.clips.indexOf(clip) + 1];
  setClipStart(tailDraft, t);
  if (tailDraft.freeze) tailDraft.freeze.hold = roundTime(end - t);
  return tailDraft;
}

/** 特效被刪掉 [a, b) 後的新範圍；整段在範圍內回 null。鏡頭關鍵幀（相對時間）依比例壓縮 */
function rippleEffect(effect: Draft<Effect>, a: Seconds, b: Seconds): boolean {
  const d = b - a;
  const { start, end } = effect;
  if (end <= a) return true;
  if (start >= b) {
    effect.start = roundTime(start - d);
    effect.end = roundTime(end - d);
    return true;
  }
  const overlap = Math.min(end, b) - Math.max(start, a);
  const oldLen = end - start;
  const newLen = roundTime(oldLen - overlap);
  if (newLen <= 0) return false;
  effect.start = roundTime(start < a ? start : a);
  effect.end = roundTime(effect.start + newLen);
  for (const key of effect.cameraKeys ?? []) key.t = roundTime((key.t * newLen) / oldLen);
  return true;
}

/**
 * V1 漣漪刪除時間軸範圍 [a, b)（spec §4、D25）：
 * 鎖定的軌不動；其他軌在 b 之後的片段左移、範圍內的刪除、跨在上面的剪掉那段；
 * 特效與時間軸定位點同樣處理；素材時間的資料（逐字稿、遮罩、建議、局部放大關鍵幀）不動。
 */
export function rippleDelete(project: Project, a: Seconds, b: Seconds): Project {
  a = roundTime(a);
  b = roundTime(b);
  if (b <= a) return project;
  const d = roundTime(b - a);
  return produce(project, (draft) => {
    const locked = new Set(draft.tracks.filter((t) => t.locked).map((t) => t.id));
    for (const clip of [...draft.clips]) {
      if (locked.has(clip.trackId)) continue;
      const cs = clip.start;
      const ce = clipEnd(clip);
      if (ce <= a) continue;
      if (cs >= b) {
        clip.start = roundTime(cs - d);
      } else if (cs >= a && ce <= b) {
        draft.clips.splice(draft.clips.indexOf(clip), 1);
      } else if (cs < a && ce > b) {
        const tail = splitDraft(draft, clip, a);
        setClipStart(tail, b);
        tail.start = a;
      } else if (cs < a) {
        setClipEnd(clip, a);
      } else {
        setClipStart(clip, b);
        clip.start = a;
      }
    }
    draft.effects = draft.effects.filter((e) => rippleEffect(e, a, b));
    draft.anchors = draft.anchors.filter((an) => an.time === undefined || an.time < a || an.time >= b);
    for (const anchor of draft.anchors) if (anchor.time !== undefined && anchor.time >= b) anchor.time = roundTime(anchor.time - d);
    layoutV1Draft(draft);
  });
}

/**
 * 改字即剪（§5.1）：刪掉選取的詞。每段連續的詞剪素材時間
 * [max(第一個詞起點 − 0.05, 前一個詞終點), min(最後一個詞終點 + 0.05, 後一個詞起點))，
 * 換算到 V1 上用到這支素材的片段，再依 D25 漣漪刪除（從後往前剪，前面的位置才不會跑掉）。
 */
export function cutByWords(project: Project, wordIds: string[]): Project {
  const selected = new Set(wordIds);
  const ranges: SourceRange[] = [];
  const mediaIds = new Set(project.words.filter((w) => selected.has(w.id)).map((w) => w.mediaId));
  for (const mediaId of mediaIds) {
    const words = project.words.filter((w) => w.mediaId === mediaId).sort((x, y) => x.start - y.start);
    const duration = project.media.find((m) => m.id === mediaId)?.duration ?? Infinity;
    // 把選取的詞分成連續的幾段，各自算出要剪的素材範圍
    for (let i = 0; i < words.length; i++) {
      if (!selected.has(words[i].id)) continue;
      let j = i;
      while (j + 1 < words.length && selected.has(words[j + 1].id)) j++;
      const lo = Math.max(words[i].start - WORD_PAD, words[i - 1]?.end ?? 0);
      const hi = Math.min(words[j].end + WORD_PAD, words[j + 1]?.start ?? duration);
      ranges.push({ mediaId, start: lo, end: hi });
      i = j;
    }
  }
  return cutSourceRanges(project, ranges);
}

/** 一段素材範圍（素材時間） */
export interface SourceRange {
  mediaId: string;
  start: Seconds;
  end: Seconds;
}

/**
 * 剪掉幾段素材範圍（改字即剪、一鍵去贅詞、清除無聲片段共用，§5.1、§5.16、§5.16b）：
 * 換算到 V1 上用到這些素材的片段 → 時間軸範圍合併重疊 → 從後往前 rippleDelete（D25 跨軌規則）。
 * 用素材時間記，幾種範圍可以一起剪：先剪的不會讓後面的位置失準。
 */
export function cutSourceRanges(project: Project, ranges: SourceRange[]): Project {
  const v1 = v1TrackId(project);
  const timeline: [Seconds, Seconds][] = [];
  for (const r of ranges) {
    for (const clip of project.clips) {
      if (clip.trackId !== v1 || clip.mediaId !== r.mediaId || clip.freeze) continue;
      const s0 = Math.max(r.start, clip.srcIn);
      const s1 = Math.min(r.end, clip.srcOut);
      if (s1 <= s0) continue;
      timeline.push([sourceToTimeline(clip, s0)!, sourceToTimeline(clip, s1)!]);
    }
  }
  // 合併重疊（重疊的範圍分開剪，後剪的那段會多剪到已經往前補過來的內容）
  timeline.sort((x, y) => x[0] - y[0]);
  const merged: [Seconds, Seconds][] = [];
  for (const r of timeline) {
    const last = merged[merged.length - 1];
    if (last && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  return merged.reverse().reduce((p, [a, b]) => rippleDelete(p, a, b), project);
}

/** 刪除片段：V1 片段用漣漪刪除（D25 跨軌規則）；其他軌只拿掉這個片段、不補位 */
export function deleteClip(project: Project, clipId: string): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip) return project;
  if (clip.trackId === v1TrackId(project)) return rippleDelete(project, clip.start, clipEnd(clip));
  return produce(project, (draft) => {
    draft.clips = draft.clips.filter((c) => c.id !== clipId);
  });
}

/** 在時間軸時間 t 切開片段（Ctrl+B）；t 不在片段內就原樣回傳 */
export function splitClip(project: Project, clipId: string, t: Seconds): Project {
  const clip = project.clips.find((c) => c.id === clipId);
  if (!clip || t <= clip.start || t >= clipEnd(clip)) return project;
  return produce(project, (draft) => {
    splitDraft(draft, draft.clips.find((c) => c.id === clipId)!, roundTime(t));
  });
}

/**
 * 修邊：把片段的入點（in）或出點（out）拖到時間軸時間 t。
 * V1 是漣漪修剪（後面的片段補位）；其他軌只動這個片段。不會超出素材範圍或短於最短長度。
 */
export function trimClip(project: Project, clipId: string, edge: "in" | "out", t: Seconds): Project {
  return produce(project, (draft) => {
    const clip = draft.clips.find((c) => c.id === clipId);
    if (!clip) return;
    const mediaDuration = draft.media.find((m) => m.id === clip.mediaId)?.duration ?? Infinity;
    const isV1 = clip.trackId === v1TrackId(draft);
    if (clip.freeze) {
      if (edge === "out") clip.freeze.hold = roundTime(Math.max(MIN_CLIP, t - clip.start));
      else if (!isV1) setClipStart(clip, Math.min(t, clipEnd(clip) - MIN_CLIP));
    } else if (edge === "out") {
      const src = Math.min(mediaDuration, Math.max(clip.srcIn + MIN_CLIP * clip.speed, timelineToSource(clip, t)));
      clip.srcOut = roundTime(src);
    } else {
      const src = Math.max(0, Math.min(clip.srcOut - MIN_CLIP * clip.speed, timelineToSource(clip, t)));
      if (!isV1) clip.start = roundTime(clip.start + (src - clip.srcIn) / clip.speed);
      clip.srcIn = roundTime(src);
    }
    clampFades(clip);
    layoutV1Draft(draft);
  });
}

/**
 * 移動片段：V2 以上與音軌直接改起點（不小於 0）；
 * V1 依新位置重新排序（插在中點比新位置小的片段之後），仍首尾相接。
 */
export function moveClip(project: Project, clipId: string, newStart: Seconds): Project {
  return produce(project, (draft) => {
    const clip = draft.clips.find((c) => c.id === clipId);
    if (!clip) return;
    const v1 = v1TrackId(draft);
    if (clip.trackId !== v1) {
      clip.start = roundTime(Math.max(0, newStart));
      return;
    }
    const others = draft.clips.filter((c) => c.trackId === v1 && c !== clip).sort((a, b) => a.start - b.start);
    const index = others.filter((c) => c.start + clipDuration(c) / 2 < newStart).length;
    others.splice(index, 0, clip);
    // 先用順序當暫時的起點，再依長度重排
    others.forEach((c, i) => { c.start = i; });
    layoutV1Draft(draft);
  });
}

/** 圖片拖到時間軸的預設長度（秒，§5.13） */
export const IMAGE_DEFAULT: Seconds = 5;

/** 離時間 t 最近的 V1 剪接點（0、每個 V1 片段的終點）；素材拖到 V1 時插在這裡 */
export function nearestV1EditPoint(project: Project, t: Seconds): Seconds {
  const v1 = v1TrackId(project);
  const points = [0, ...project.clips.filter((c) => c.trackId === v1).map(clipEnd)];
  return points.reduce((best, p) => (Math.abs(p - t) < Math.abs(best - t) ? p : best), 0);
}

/** 特效在時間 p 插入長度 d 之後：整段在 p 之後的右移；跨在 p 上的拉長 d，鏡頭關鍵幀依比例拉開 */
function insertIntoEffect(effect: Draft<Effect>, p: Seconds, d: Seconds) {
  if (effect.end <= p) return;
  if (effect.start >= p) {
    effect.start = roundTime(effect.start + d);
    effect.end = roundTime(effect.end + d);
    return;
  }
  const oldLen = effect.end - effect.start;
  effect.end = roundTime(effect.end + d);
  const newLen = effect.end - effect.start;
  for (const key of effect.cameraKeys ?? []) key.t = roundTime((key.t * newLen) / oldLen);
}

/**
 * 漣漪插入（D25 的反向）：在時間軸時間 p 空出長度 d。鎖定的軌不動；
 * 其他軌整段在 p 之後的片段右移、跨在 p 上的切開後半段右移；特效與時間軸定位點同樣右移。
 */
export function rippleInsertDraft(draft: Draft<Project>, p: Seconds, d: Seconds) {
  const locked = new Set(draft.tracks.filter((t) => t.locked).map((t) => t.id));
  for (const clip of [...draft.clips]) {
    if (locked.has(clip.trackId) || clipEnd(clip) <= p) continue;
    if (clip.start >= p) clip.start = roundTime(clip.start + d);
    else splitDraft(draft, clip, p).start = roundTime(p + d);
  }
  for (const effect of draft.effects) insertIntoEffect(effect, p, d);
  for (const anchor of draft.anchors) if (anchor.time !== undefined && anchor.time >= p) anchor.time = roundTime(anchor.time + d);
}

/** 依基底產生不重複的片段 id */
function newClipId(draft: Draft<Project>, base: string): string {
  return draft.clips.some((c) => c.id === base) ? uniqueId(draft, base) : base;
}

/**
 * 把素材拖到軌道上的時間 t（§5.13、D15）：
 * - 影片、圖片放影像軌；影片有聲音的話，聲音拆成對白軌（A1）上獨立的片段，同一時間。
 * - 聲音放音軌；影片拖到音軌只放它的聲音。
 * - V1：插在離 t 最近的剪接點，依 D25 反向漣漪（後面的片段與其他未鎖定軌一起右移）。其他軌放在 t、不漣漪。
 * 放不下的組合（音訊到影像軌、圖片或無聲影片到音軌、鎖定的軌、找不到素材）原樣回傳。
 */
export function placeMedia(project: Project, mediaId: string, trackId: string, t: Seconds): Project {
  const media = project.media.find((m) => m.id === mediaId);
  const target = project.tracks.find((tr) => tr.id === trackId);
  if (!media || !target || target.locked) return project;
  const visual = media.kind === "video" || media.kind === "image";
  const hasAudio = media.kind === "audio" || (media.kind === "video" && media.audio === true);
  if (target.kind === "video" ? !visual : !hasAudio) return project;

  const length = media.kind === "image" ? IMAGE_DEFAULT : media.duration;
  const isV1 = trackId === v1TrackId(project);
  const at = roundTime(isV1 ? nearestV1EditPoint(project, t) : Math.max(0, t));
  const dialogue = project.tracks.filter((tr) => tr.kind === "audio").sort((a, b) => a.index - b.index).find((tr) => tr.role === "dialogue")?.id;
  const audioTrack = target.kind === "audio" ? trackId : media.kind === "video" && hasAudio ? dialogue : undefined;

  return produce(project, (draft) => {
    if (isV1) rippleInsertDraft(draft, at, length);
    /** 建一個從素材開頭開始、長度 length 的片段 */
    const add = (onTrack: string) => {
      draft.clips.push({
        id: newClipId(draft, `${mediaId}@${onTrack}`),
        mediaId, trackId: onTrack, srcIn: 0, srcOut: roundTime(length), start: at,
        speed: 1, opacity: 1, fadeIn: 0, fadeOut: 0, volume: 1,
      });
    };
    if (target.kind === "video") add(trackId);
    if (audioTrack) add(audioTrack);
    layoutV1Draft(draft);
  });
}
