// MP4 匯出（spec §5.4，D24）：和預覽共用 layerPlan 與 GlCompositor，畫面來源改成 WebCodecs 逐格解碼原檔。
// 解一格、畫一格、編一格（不在記憶體累積）；2D／3D 特效向沙盒逐格 await；聲音由 audioMix 分段混好後送編碼器（和影像並行）。
// mediabunny 串流寫進 Engine 給的 ExportTarget（Windows 版 Rust 分塊寫檔、網頁版可寫串流）。
import { MaskLayer } from "../sam/maskLayer";
import type { AudioSampleSource, Input, VideoSample } from "mediabunny";
import type { EffectRenderer } from "../anim/effectRenderer";
import { layerPlan } from "../compositor/layerPlan";
import { GlCompositor } from "../compositor/glCompositor";
import type { Media, Project } from "../core/model";
import type { ExportTarget } from "../engine/Engine";
import { clipFrames, type ExportPlan } from "./exportPlan";
import { CaptionLayer, loadCaptionFonts } from "../captions/captionLayer";
import { DEFAULT_CAPTION_STYLE } from "../captions/captionLayout";
import type { Caption, TimelineWord } from "../core/captions";

/** 匯出進度 */
export interface ExportProgress {
  /** 已編碼的格數 */
  frame: number;
  total: number;
}

/** 一次匯出需要的東西 */
export interface ExportJob {
  project: Project;
  plan: ExportPlan;
  /** 素材 → 原檔來源（Engine.exportSource） */
  source: (media: Media) => Promise<Blob | string>;
  target: ExportTarget;
  /** 特效沙盒（沒有就不畫特效） */
  effects: EffectRenderer | null;
  /** 聲音：把整段混音送進 audioSource（由 audioMix 提供）；沒有就輸出無聲 */
  audio?: (audioSource: AudioSampleSource, signal: AbortSignal) => Promise<void>;
  /** 聲音編碼：aac 或 opus（呼叫端用 canEncodeAudio 選好） */
  audioCodec?: "aac" | "opus";
  /** 燒進畫面的字幕（樣式在 project.captionStyle；none 時不畫） */
  captions?: { captions: Caption[]; words: TimelineWord[] };
  onProgress?: (p: ExportProgress) => void;
  signal?: AbortSignal;
}

/** 匯出結果 */
export interface ExportResult {
  /** 畫不出來而略過的特效（特效 id → 第一個錯誤） */
  effectErrors: Map<string, string>;
}

/** 使用者取消 */
export class ExportCancelled extends Error {
  constructor() {
    super("Export cancelled");
    this.name = "ExportCancelled";
  }
}

/** 一個片段的解碼串流：預先要下一格（解碼和合成重疊） */
interface ClipStream {
  iter: AsyncGenerator<VideoSample | null, void, unknown>;
  pending: Promise<IteratorResult<VideoSample | null, void>>;
  last: number;
}

/** 動態載入 mediabunny（拆成獨立分塊） */
const loadMediabunny = () => import("mediabunny");

/**
 * 硬體編碼器能不能編這個大小（§5.21：優先硬體，沒有就軟體）。
 * 沒有硬體編碼器的環境（例如無頭 Chromium）指定 prefer-hardware 會直接報錯，所以先問。
 */
async function hardwarePreference(plan: ExportPlan): Promise<HardwareAcceleration> {
  try {
    const { supported } = await VideoEncoder.isConfigSupported({ codec: "avc1.640028", width: plan.width, height: plan.height, bitrate: plan.videoBitrate, framerate: plan.fps, hardwareAcceleration: "prefer-hardware" });
    return supported ? "prefer-hardware" : "no-preference";
  } catch {
    return "no-preference";
  }
}

/** 執行匯出；取消時拋 ExportCancelled（寫了一半的檔案由 target.abort 刪掉） */
export async function runExport(job: ExportJob): Promise<ExportResult> {
  const mb = await loadMediabunny();
  const { project, plan, target, effects } = job;
  const signal = job.signal ?? new AbortController().signal;
  const effectErrors = new Map<string, string>();
  const canvas = new OffscreenCanvas(plan.width, plan.height);
  const compositor = new GlCompositor(canvas);
  /** SAM 遮罩圖層 */
  const masks = new MaskLayer();
  // 字幕：開始前把要用到的字型（中文分塊）全部載好，第一格就用對的字型
  const captionLayer = job.captions?.captions.length ? new CaptionLayer(plan.width, plan.height) : null;
  if (captionLayer) await loadCaptionFonts(job.captions!.captions.map((c) => c.lines.join(" ")));
  const captionStyle = project.captionStyle ?? DEFAULT_CAPTION_STYLE;

  /** 每支素材一個 Input（同一支素材的多個片段共用） */
  const inputs = new Map<string, Input>();
  /** 圖片素材解好的 ImageBitmap */
  const images = new Map<string, ImageBitmap>();
  const openInput = async (media: Media): Promise<Input> => {
    let input = inputs.get(media.id);
    if (!input) {
      const src = await job.source(media);
      input = new mb.Input({ source: typeof src === "string" ? new mb.UrlSource(src) : new mb.BlobSource(src), formats: mb.ALL_FORMATS });
      inputs.set(media.id, input);
    }
    return input;
  };
  const imageOf = async (media: Media): Promise<ImageBitmap> => {
    let bitmap = images.get(media.id);
    if (!bitmap) {
      const src = await job.source(media);
      const blob = typeof src === "string" ? await (await fetch(src)).blob() : src;
      bitmap = await createImageBitmap(blob, { premultiplyAlpha: "premultiply" });
      images.set(media.id, bitmap);
    }
    return bitmap;
  };

  const writable = new WritableStream<{ type: "write"; data: Uint8Array; position: number }>({
    write: (chunk) => target.write(chunk.position, chunk.data),
  });
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: false }), target: new mb.StreamTarget(writable, { chunked: true }) });
  const videoSource = new mb.CanvasSource(canvas, { codec: "avc", bitrate: plan.videoBitrate, keyFrameInterval: 2, hardwareAcceleration: await hardwarePreference(plan) });
  output.addVideoTrack(videoSource, { frameRate: plan.fps });
  const audioSource = job.audio ? new mb.AudioSampleSource({ codec: job.audioCodec ?? "aac", bitrate: plan.audioBitrate }) : null;
  if (audioSource) output.addAudioTrack(audioSource);
  await output.start();

  const streams = new Map<string, ClipStream>();
  const ranges = clipFrames(project, plan.fps, plan.frames);
  let nextRange = 0;
  try {
    const audioJob = audioSource && job.audio ? job.audio(audioSource, signal) : Promise.resolve();
    // 聲音失敗時不要等到影像全部做完才知道
    let audioError: unknown = null;
    audioJob.catch((e) => { audioError = e; });

    for (let i = 0; i < plan.frames; i++) {
      if (signal.aborted) throw new ExportCancelled();
      if (audioError) throw audioError;
      const t = i / plan.fps;
      // 這一格開始的片段：開解碼串流（影片）或先解好圖片
      while (nextRange < ranges.length && ranges[nextRange].first <= i) {
        const r = ranges[nextRange++];
        const media = project.media.find((m) => m.id === r.mediaId);
        if (!media || r.last < i) continue;
        if (media.kind === "image") {
          await imageOf(media);
          continue;
        }
        if (media.kind !== "video") continue;
        const track = await (await openInput(media)).getPrimaryVideoTrack();
        if (!track) continue;
        const iter = new mb.VideoSampleSink(track).samplesAtTimestamps(r.srcTimes.slice(i - r.first));
        streams.set(r.clipId, { iter, pending: iter.next(), last: r.last });
      }
      // 每個開著的串流這一格都要取一格（不管有沒有畫到），並預先要下一格
      const samples = new Map<string, VideoSample>();
      for (const [clipId, s] of streams) {
        const result = await s.pending;
        if (result.value) samples.set(clipId, result.value);
        if (i < s.last) s.pending = s.iter.next();
        else {
          void s.iter.return(undefined);
          streams.delete(clipId);
        }
      }

      compositor.begin();
      for (const item of layerPlan(project, t, plan.fps)) {
        if (item.kind === "video") {
          const { layer } = item;
          const media = project.media.find((m) => m.id === layer.mediaId);
          if (media?.kind === "image") {
            const bitmap = images.get(media.id);
            if (bitmap) compositor.draw(bitmap, layer.rect, layer.opacity, layer.crop);
            continue;
          }
          const sample = samples.get(layer.clipId);
          if (!sample) continue;
          const frame = sample.toVideoFrame();
          compositor.draw(frame, layer.rect, layer.opacity, layer.crop);
          // SAM 遮罩（和預覽同一個畫法）
          masks.draw(compositor, project, layer, frame, plan.width, plan.height);
          frame.close();
          continue;
        }
        // 特效：沙盒畫完這一格才往下（和預覽同一個插件、同一套請求）
        const effect = project.effects.find((e) => e.id === item.effectId);
        if (!effects || !effect || effectErrors.has(effect.id)) continue;
        try {
          const background = (await effects.needsBackground(effect)) ? await createImageBitmap(canvas) : null;
          const req = { frame: item.frame, fps: plan.fps, duration: item.duration, width: plan.width, height: plan.height, videoW: plan.width, videoH: plan.height };
          const bitmap = await effects.renderFrame(effect, req, background);
          compositor.draw(bitmap, { x: 0, y: 0, w: 1, h: 1 }, 1);
          bitmap.close();
        } catch (e) {
          // 插件出錯：這個特效之後都略過，匯出照常完成，最後告訴使用者
          effectErrors.set(effect.id, e instanceof Error ? e.message : String(e));
        }
      }
      for (const sample of samples.values()) sample.close();
      // 字幕畫在最上層（和預覽同一個 CaptionLayer）
      const captionCanvas = captionLayer?.render(job.captions!.captions, job.captions!.words, t, captionStyle, plan.width, plan.height);
      if (captionCanvas) compositor.draw(captionCanvas, { x: 0, y: 0, w: 1, h: 1 }, 1);

      await videoSource.add(t, 1 / plan.fps);
      job.onProgress?.({ frame: i + 1, total: plan.frames });
    }
    videoSource.close();
    await audioJob;
    if (signal.aborted) throw new ExportCancelled();
    await output.finalize();
    await target.close();
    return { effectErrors };
  } catch (e) {
    await output.cancel().catch(() => undefined);
    await target.abort().catch(() => undefined);
    throw signal.aborted ? new ExportCancelled() : e;
  } finally {
    // 預先要的下一格（取消或出錯時還沒用到）也要釋放，否則解碼器的畫格會被 GC 回收才關
    for (const s of streams.values()) {
      void s.pending.then((r) => r.value?.close(), () => undefined);
      void s.iter.return(undefined);
    }
    for (const bitmap of images.values()) bitmap.close();
    for (const input of inputs.values()) input.dispose?.();
  }
}
