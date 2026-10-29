// MP4 匯出的規劃（spec §5.4）：輸出大小、格率、長度、位元率，以及每個影像片段要解哪些格。純函式，Vitest 測。
// 每格畫什麼仍由預覽共用的 layerPlan 決定（D24）；這裡只算匯出才需要的部分。
import type { Project, Seconds } from "../core/model";
import { clipEnd, timelineToSource } from "../core/timeline";
import { projectDuration } from "../ui/state";

/** 解析度選項：依素材（V1 第一個片段的素材）、1080p、720p */
export type ExportPreset = "source" | "1080p" | "720p";

/** 匯出設定 */
export interface ExportPlan {
  width: number;
  height: number;
  fps: number;
  /** 成片長度（秒） */
  duration: Seconds;
  /** 總格數 */
  frames: number;
  /** 影像位元率（bps） */
  videoBitrate: number;
  /** 聲音位元率（bps） */
  audioBitrate: number;
}

/** 1080p30 的基準位元率 */
const BASE_BITRATE = 8_000_000;
/** 影像位元率下限 */
const MIN_BITRATE = 1_500_000;

/** 往下取偶數（H.264 的寬高要偶數），至少 2 */
function even(n: number): number {
  return Math.max(2, Math.floor(n / 2) * 2);
}

/** 依解析度選項算出匯出設定 */
export function exportPlan(project: Project, preset: ExportPreset): ExportPlan {
  const v1 = [...project.tracks].filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0];
  const v1Media = project.clips.filter((c) => c.trackId === v1?.id).sort((a, b) => a.start - b.start)
    .map((c) => project.media.find((m) => m.id === c.mediaId)).filter((m) => m !== undefined);
  // 依 V1 上第一支影片（開頭可能是片頭的佔位圖）；全是圖片才用第一個片段
  const media = v1Media.find((m) => m.kind === "video") ?? v1Media[0];
  const srcW = media?.width ?? 1920;
  const srcH = media?.height ?? 1080;
  const fps = Math.min(60, Math.max(1, Math.round(media?.fps ?? 30)));
  let width = even(srcW);
  let height = even(srcH);
  if (preset !== "source") {
    height = preset === "1080p" ? 1080 : 720;
    width = even(Math.round((height * srcW) / srcH));
  }
  const duration = projectDuration(project);
  const videoBitrate = Math.max(MIN_BITRATE, Math.round(BASE_BITRATE * ((width * height) / (1920 * 1080)) * (fps / 30)));
  return { width, height, fps, duration, frames: Math.round(duration * fps), videoBitrate, audioBitrate: 160_000 };
}

/** 一個影像片段在成片裡涵蓋的格 */
export interface ClipFrames {
  clipId: string;
  mediaId: string;
  /** 第一格與最後一格（含） */
  first: number;
  last: number;
  /** first～last 每一格要取的素材時間 */
  srcTimes: Seconds[];
}

/**
 * 每個影像片段（未靜音的影像軌）涵蓋哪些格、每格取素材的哪個時間；依開始的格排序（同一格依軌道順序）。
 * 匯出時每個片段開一條解碼串流，從 first 開到 last 就關掉，同時開著的串流只有畫面上疊著的那幾個。
 * 格 i 的時間是 i / fps，和 framePlan 一樣「起點含、終點不含」。
 */
export function clipFrames(project: Project, fps: number, frames: number): ClipFrames[] {
  const tracks = new Map(project.tracks.filter((t) => t.kind === "video" && !t.muted).map((t) => [t.id, t.index]));
  const out: (ClipFrames & { track: number })[] = [];
  for (const clip of project.clips) {
    const track = tracks.get(clip.trackId);
    if (track === undefined) continue;
    const end = clipEnd(clip);
    const first = Math.max(0, Math.ceil(clip.start * fps - 1e-6));
    let last = Math.min(frames - 1, Math.ceil(end * fps - 1e-6) - 1);
    // 浮點誤差：最後一格的時間要嚴格小於終點
    while (last >= first && last / fps >= end) last--;
    if (last < first) continue;
    const srcTimes: Seconds[] = [];
    for (let i = first; i <= last; i++) srcTimes.push(timelineToSource(clip, i / fps));
    out.push({ clipId: clip.id, mediaId: clip.mediaId, first, last, srcTimes, track });
  }
  out.sort((a, b) => a.first - b.first || a.track - b.track);
  return out.map(({ track: _track, ...rest }) => rest);
}
