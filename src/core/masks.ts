// SAM 遮罩的專案編輯（spec §5.3）：遮罩屬於素材（素材時間），片段移到哪裡都套得上；加入、改設定、刪除都是可復原的編輯。
import type { MaskObject, Project, Seconds } from "./model";
import { clipEnd, timelineToSource } from "./timeline";

/** 加入遮罩物件（一次 SAM 執行的結果） */
export function addMasks(project: Project, masks: MaskObject[]): Project {
  return { ...project, masks: [...(project.masks ?? []), ...masks] };
}

/** 換掉一個遮罩物件（開關、效果、強度、外擴） */
export function setMask(project: Project, mask: MaskObject): Project {
  return { ...project, masks: (project.masks ?? []).map((m) => (m.id === mask.id ? mask : m)) };
}

/** 刪除遮罩物件 */
export function deleteMasks(project: Project, ids: string[]): Project {
  const drop = new Set(ids);
  return { ...project, masks: (project.masks ?? []).filter((m) => !drop.has(m.id)) };
}

/**
 * 時間軸範圍 → 要送 SAM 的素材範圍（照 zoomFromRange：起點所在的 V1 片段，終點夾在那個片段內）；
 * 起點不在 V1 片段上（或是定格片段）回 null。
 */
export function maskSourceRange(project: Project, range: { start: Seconds; end: Seconds }): { mediaId: string; start: Seconds; end: Seconds } | null {
  const v1 = project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  const clip = project.clips.find((c) => c.trackId === v1 && !c.freeze && c.start <= range.start && range.start < clipEnd(c));
  if (!clip) return null;
  const start = timelineToSource(clip, range.start);
  const end = Math.min(timelineToSource(clip, Math.min(range.end, clipEnd(clip))), clip.srcOut);
  return end - start < 0.2 ? null : { mediaId: clip.mediaId, start, end };
}
