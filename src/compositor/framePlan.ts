// 每一格要畫什麼（spec §5.4、§5.10）：純函式，預覽與匯出共用（D24）。
// 由下到上：V1 主軌 → V2、V3…疊加軌；3D 場景、插件、字幕之後在合成器裡接著疊。
import type { Clip, Project, Rect, Seconds } from "../core/model";
import { clipDuration, clipEnd, timelineToSource } from "../core/timeline";
import { zoomCrop, zoomState } from "../core/zoom";
import { isMutedAt, mutedRangesFor } from "../core/voiceover";
import { applySide, type TransitionSide, cutAt, extendedSource, transitionAudioFactor, transitionCuts, transitionLook, visibleRange } from "../core/transitions";
import { gradeAt, type GradeValues } from "../core/colorGrade";

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
  /** 純色圖層（穿黑／白轉場，§5.9）：有這個欄位就畫純色，不取素材（mediaId 是空字串） */
  solid?: [number, number, number];
  /** 色彩調整（P3；沒調就沒有） */
  grade?: GradeValues;
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

/** 時間軸時間 t 這一格的影像圖層，由下到上。V1 依起點排序（轉場時前一段在下、後一段在上），轉場窗內兩段都畫 */
export function framePlan(project: Project, t: Seconds): VideoLayer[] {
  const tracks = project.tracks.filter((tr) => tr.kind === "video" && !tr.muted).sort((a, b) => a.index - b.index);
  const v1 = [...project.tracks].filter((tr) => tr.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  const cuts = transitionCuts(project);
  /** t 所在的轉場窗（只有 V1 有轉場） */
  const inCut = cutAt(cuts, t);
  const look = inCut ? transitionLook(inCut.cut.transition.kind, inCut.p) : null;
  const grade = gradeAt(project, t);
  const layers: VideoLayer[] = [];
  for (const track of tracks) {
    const clips = project.clips.filter((c) => c.trackId === track.id);
    if (track.id === v1) clips.sort((a, b) => a.start - b.start);
    for (const clip of clips) {
      let rect = clip.transform ?? FULL;
      let factor = 1;
      /** 轉場對這一段的影響（不在轉場裡就沒有） */
      let sideLook: TransitionSide | null = null;
      if (track.id === v1 && inCut && look) {
        const role = inCut.cut.prev.id === clip.id ? "prev" : inCut.cut.next.id === clip.id ? "next" : null;
        if (role) {
          const range = visibleRange(cuts, clip);
          if (t < range.from || t >= range.to) continue;
          factor = look[role].opacity;
          sideLook = look[role];
        } else if (!covers(clip, t)) continue;
      } else if (!covers(clip, t)) continue;
      if (factor <= 0) continue;
      const media = project.media.find((m) => m.id === clip.mediaId);
      const srcTime = extendedSource(clip, t, media);
      // 淡入淡出在延伸出去的時間用片段邊上的值（不會因為在片段外就變成 0）
      const local = Math.min(Math.max(t, clip.start), clipEnd(clip) - 1e-6);
      // 局部放大：這支素材啟用中、包含這個素材時間的那一段（§5.19）
      const region = project.zooms?.find((z) => z.enabled && z.mediaId === clip.mediaId && srcTime >= z.start && srcTime <= z.end);
      const zoom = region ? zoomState(region, srcTime) : null;
      // 轉場：縮放、位移、只露出一塊（擦除）；和局部放大的裁切疊在一起
      const placed = sideLook ? applySide(rect, zoom && zoom.scale > 1 ? zoomCrop(zoom) : undefined, sideLook) : { rect, ...(zoom && zoom.scale > 1 ? { crop: zoomCrop(zoom) } : {}) };
      layers.push({
        clipId: clip.id,
        mediaId: clip.mediaId,
        srcTime,
        rect: placed.rect,
        opacity: clip.opacity * fadeFactor(clip, local) * factor,
        ...(placed.crop ? { crop: placed.crop } : {}),
        ...(grade ? { grade } : {}),
      });
    }
    // 穿黑／白：純色蓋在 V1 兩段上面（疊加軌之下）
    if (track.id === v1 && inCut && look?.solid && look.solid.opacity > 0) {
      layers.push({ clipId: `transition:${inCut.cut.transition.id}`, mediaId: "", srcTime: 0, rect: FULL, opacity: look.solid.opacity, solid: look.solid.color });
    }
  }
  return layers;
}

/** 時間軸時間 t 正在發聲的音訊片段（軌道靜音的不算）；重配音（§5.6）生效範圍內的對白、聽原音時的 AI 片段仍在清單裡但增益是 0（元素照常同步，離開範圍就接得上） */
export function audioPlan(project: Project, t: Seconds): AudioVoice[] {
  const voices: AudioVoice[] = [];
  const cuts = transitionCuts(project);
  for (const track of project.tracks) {
    if (track.kind !== "audio" || track.muted) continue;
    for (const clip of project.clips) {
      if (clip.trackId !== track.id || !covers(clip, t)) continue;
      voices.push({
        clipId: clip.id,
        mediaId: clip.mediaId,
        srcTime: timelineToSource(clip, t),
        gain: isMutedAt(mutedRangesFor(project, clip, track), t) ? 0 : clip.volume * track.volume * fadeFactor(clip, t) * transitionAudioFactor(project, cuts, clip, t),
        speed: clip.speed,
      });
    }
  }
  return voices;
}
