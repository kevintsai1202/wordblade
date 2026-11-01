// AI 重配音（spec §5.6）的資料操作與靜音規則：全是「舊專案 → 新專案」的純函式，預覽（audioPlan）與匯出（mixSpan）共用同一套靜音判斷。
import { produce } from "immer";
import type { Clip, Project, Seconds, Track, Voiceover } from "./model";
import { clipEnd, placeMedia } from "./timeline";
import { setClipSpeed } from "./speed";

/** 匯出時靜音範圍邊緣的淡出入長度（秒），避免硬切造成爆音 */
export const MUTE_FADE: Seconds = 0.01;

/** 一段靜音的時間軸範圍 [from, to) */
export interface MuteRange {
  from: Seconds;
  to: Seconds;
}

/** 重配音的 AI 片段是否還在時間軸上（使用者手動刪掉片段後，這筆重配音就不再生效） */
function liveVoiceovers(project: Project): Voiceover[] {
  return (project.voiceovers ?? []).filter((v) => project.clips.some((c) => c.id === v.clipId));
}

/**
 * 目前生效（active，且 AI 片段還在）的重配音範圍：這些時間內原本的對白要靜音。
 * 起點跟著 AI 片段在時間軸上的位置走（前面剪掉或移動時，記錄的 start 會過時，片段才是準的），長度是框選範圍的長度。
 */
export function activeVoiceoverRanges(project: Project): MuteRange[] {
  return liveVoiceovers(project).filter((v) => v.active).map((v) => {
    // 起點跟著片段走，長度是使用者框的範圍（AI 聲音可能比範圍短，範圍內的原音一樣要靜音）
    const clip = project.clips.find((c) => c.id === v.clipId)!;
    return { from: clip.start, to: clip.start + (v.end - v.start) };
  });
}

/**
 * 這個片段必須靜音的時間軸範圍：
 * - 對白軌（role="dialogue"）的片段：所有生效中的重配音範圍；
 * - 重配音的 AI 片段：重配音關掉（聽原音）時整段靜音；
 * - 其他片段（配樂、音效…）：不受影響。
 */
export function mutedRangesFor(project: Project, clip: Clip, track: Track | undefined): MuteRange[] {
  if (!project.voiceovers?.length || !track || track.kind !== "audio") return [];
  const own = project.voiceovers.find((v) => v.clipId === clip.id);
  if (own) return own.active ? [] : [{ from: clip.start, to: clipEnd(clip) }];
  if (track.role === "dialogue") return activeVoiceoverRanges(project);
  return [];
}

/** 時間軸時間 t 是否落在任一靜音範圍內（起點含、終點不含；預覽用，直接把增益設 0） */
export function isMutedAt(ranges: MuteRange[], t: Seconds): boolean {
  return ranges.some((r) => t >= r.from && t < r.to);
}

/**
 * 時間 t 的靜音係數（0～1；匯出用）：範圍內是 0，範圍外 fade 秒內線性漸變回 1。
 * 這樣對白在重配音開始前 10 ms 淡出、結束後 10 ms 淡入，不會硬切。
 */
export function muteFactor(ranges: MuteRange[], t: Seconds, fade: Seconds = MUTE_FADE): number {
  let f = 1;
  for (const r of ranges) {
    if (t >= r.from && t < r.to) return 0;
    const dist = t < r.from ? r.from - t : t - r.to;
    if (dist < fade) f = Math.min(f, dist / fade);
  }
  return f;
}

/** 新增重配音需要的內容（clipId 由 addVoiceover 決定） */
export type NewVoiceover = Omit<Voiceover, "clipId" | "active">;

/** 找一個不重複的軌道 id：A4、A5… */
export function freeTrackId(project: Project): string {
  const ids = new Set(project.tracks.map((t) => t.id));
  for (let n = project.tracks.filter((t) => t.kind === "audio").length + 1; ; n++) if (!ids.has(`A${n}`)) return `A${n}`;
}

/**
 * 加一筆重配音（一次提交）：沒有 role="voice" 的音軌就在所有音軌最後面建一條，
 * 把 AI 聲音的素材放在這條軌的 v.start（沿用 placeMedia），需要時套變速（保持音高），再記錄這筆重配音。
 * 素材不在專案裡、軌道鎖定、放不上去時原樣回傳。
 */
export function addVoiceover(project: Project, v: NewVoiceover, speed = 1): Project {
  if (!project.media.some((m) => m.id === v.mediaId)) return project;
  let p = project;
  let track = p.tracks.find((t) => t.kind === "audio" && t.role === "voice");
  if (!track) {
    const index = p.tracks.filter((t) => t.kind === "audio").reduce((max, t) => Math.max(max, t.index), -1) + 1;
    track = { id: freeTrackId(p), kind: "audio", role: "voice", index, muted: false, locked: false, volume: 1 };
    const created = track;
    p = produce(p, (d) => { d.tracks.push(created); });
  }
  if (track.locked) return project;
  const before = new Set(p.clips.map((c) => c.id));
  p = placeMedia(p, v.mediaId, track.id, v.start);
  const clip = p.clips.find((c) => !before.has(c.id));
  if (!clip) return project;
  if (speed !== 1) p = setClipSpeed(p, clip.id, speed);
  const record: Voiceover = { ...v, clipId: clip.id, active: true };
  return produce(p, (d) => { d.voiceovers = [...(d.voiceovers ?? []).filter((x) => x.id !== v.id), record]; });
}

/** 切換某筆重配音要聽 AI（true）或原音（false）；找不到或沒變就回傳原物件 */
export function setVoiceoverActive(project: Project, id: string, active: boolean): Project {
  const v = project.voiceovers?.find((x) => x.id === id);
  if (!v || v.active === active) return project;
  return produce(project, (d) => { d.voiceovers!.find((x) => x.id === id)!.active = active; });
}

/** 刪掉一筆重配音：AI 片段與紀錄一起拿掉（素材留在素材庫、軌道留著）；原音恢復 */
export function deleteVoiceover(project: Project, id: string): Project {
  const v = project.voiceovers?.find((x) => x.id === id);
  if (!v) return project;
  return produce(project, (d) => {
    d.clips = d.clips.filter((c) => c.id !== v.clipId);
    d.voiceovers = d.voiceovers!.filter((x) => x.id !== id);
  });
}
