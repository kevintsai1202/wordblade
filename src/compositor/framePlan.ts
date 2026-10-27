// 每一格要畫什麼（spec §5.4、§5.10）：純函式，預覽與匯出共用（D24）。
// 由下到上：V1 主軌 → V2、V3…疊加軌；3D 場景、插件、字幕之後在合成器裡接著疊。
import type { Clip, Project, Rect, Seconds } from "../core/model";
import { clipDuration, clipEnd, timelineToSource } from "../core/timeline";
import { zoomAt, zoomCrop } from "../core/zoom";

/** 全畫面的框 */
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };

/** 一個影像圖層 */
export interface VideoLayer {
  clipId: string;
  mediaId: string;
  /** 這一格要取的素材時間 */
  srcTime: Seconds;
  /** 畫在畫面上的框（0～1） */
  rect: Rect;
  /** 透明度（已含淡入淡出） */
  opacity: number;
  /** 局部放大：只取素材畫面的這個範圍放大畫滿（§5.19；沒放大就沒有） */
  crop?: Rect;
}

/** 一個發聲中的音訊片段 */
export interface AudioVoice {
  clipId: string;
  mediaId: string;
  srcTime: Seconds;
  /** 片段音量×軌道音量（含淡入淡出） */
  gain: number;
  speed: number;
}

/** 時間 t 是否在片段內（起點含、終點不含） */
function covers(clip: Clip, t: Seconds): boolean {
  return t >= clip.start && t < clipEnd(clip);
}

/** 淡入淡出的係數（0～1）；匯出混音也用 */
export function fadeFactor(clip: Clip, t: Seconds): number {
  const local = t - clip.start;
  const remain = clipDuration(clip) - local;
  let f = 1;
  if (clip.fadeIn > 0) f = Math.min(f, local / clip.fadeIn);
  if (clip.fadeOut > 0) f = Math.min(f, remain / clip.fadeOut);
  return Math.max(0, Math.min(1, f));
}

/** 時間軸時間 t 這一格的影像圖層，由下到上 */
export function framePlan(project: Project, t: Seconds): VideoLayer[] {
  const tracks = project.tracks.filter((tr) => tr.kind === "video" && !tr.muted).sort((a, b) => a.index - b.index);
  const layers: VideoLayer[] = [];
  for (const track of tracks) {
    for (const clip of project.clips) {
      if (clip.trackId !== track.id || !covers(clip, t)) continue;
      const srcTime = timelineToSource(clip, t);
      const zoom = clip.zoomKeys?.length ? zoomAt(clip, srcTime) : null;
      layers.push({
        clipId: clip.id,
        mediaId: clip.mediaId,
        srcTime,
        rect: clip.transform ?? FULL,
        opacity: clip.opacity * fadeFactor(clip, t),
        ...(zoom && zoom.scale > 1 ? { crop: zoomCrop(zoom) } : {}),
      });
    }
  }
  return layers;
}

/** 時間軸時間 t 正在發聲的音訊片段（軌道靜音的不算） */
export function audioPlan(project: Project, t: Seconds): AudioVoice[] {
  const voices: AudioVoice[] = [];
  for (const track of project.tracks) {
    if (track.kind !== "audio" || track.muted) continue;
    for (const clip of project.clips) {
      if (clip.trackId !== track.id || !covers(clip, t)) continue;
      voices.push({
        clipId: clip.id,
        mediaId: clip.mediaId,
        srcTime: timelineToSource(clip, t),
        gain: clip.volume * track.volume * fadeFactor(clip, t),
        speed: clip.speed,
      });
    }
  }
  return voices;
}
