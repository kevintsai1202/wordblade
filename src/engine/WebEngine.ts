import type { InputFormat } from "mediabunny";
import { EnvelopeBuilder } from "../audio/envelope";
import type { Media } from "../core/model";
import { IMAGE_DURATION } from "../core/media";
import { NotImplementedError, UnsupportedMediaError, type Engine, type ImportSource, type Prepared } from "./Engine";
import { classifyFile, webSupport } from "./webFormats";

/** 選檔對話框接受的類型 */
const ACCEPT = "video/*,image/*,audio/*,.mov,.m4a";
/** 縮圖寬度（像素） */
const THUMB_WIDTH = 160;

/** mediabunny 只在網頁版匯入時用到：動態載入，拆成獨立分塊，桌面版與首次載入都不必下載 */
const loadMediabunny = () => import("mediabunny");

/** mediabunny 的格式 → webSupport 用的短名 */
function containerName(mb: typeof import("mediabunny"), format: InputFormat): string | null {
  if (format === mb.MP4) return "mp4";
  if (format === mb.QTFF) return "mov";
  if (format === mb.WAVE) return "wave";
  if (format === mb.MP3) return "mp3";
  return format.name.toLowerCase();
}

/** 畫布轉成縮圖網址 */
async function canvasToUrl(canvas: HTMLCanvasElement | OffscreenCanvas): Promise<string> {
  const blob = canvas instanceof OffscreenCanvas ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 }) : await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("toBlob failed"))), "image/jpeg", 0.8));
  return URL.createObjectURL(blob);
}

/** 網頁版：Chrome／Edge 的 WebCodecs、File System Access、OPFS（§5.21） */
export class WebEngine implements Engine {
  readonly kind = "web" as const;
  readonly capabilities = { vocalSeparation: false, anyFormatImport: false };
  /** 匯入的檔案：handleKey → File 與預覽用的 blob 網址（重新整理後就沒有；存開專案做好後改存 FileSystemHandle） */
  private readonly files = new Map<string, { file: File; url: string }>();

  /** 匯入的檔案用 blob 網址；專案內的相對路徑（開發伺服器以 /samples/ 提供）照舊 */
  mediaUrl(media: Media): string {
    if (media.handleKey) return this.files.get(media.handleKey)?.url ?? "";
    const path = media.proxyPath ?? media.path ?? "";
    return path.startsWith("/") || /^[a-z]+:/i.test(path) ? path : `/${path}`;
  }

  /** 用隱藏的 <input type=file> 選檔 */
  pickFiles(): Promise<ImportSource[]> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = ACCEPT;
      input.addEventListener("change", () => resolve(Array.from(input.files ?? [], (file) => ({ kind: "file" as const, file, name: file.name }))));
      input.addEventListener("cancel", () => resolve([]));
      input.click();
    });
  }

  /** HTML5 拖放：整個視窗都可以放檔案 */
  onFilesDropped(handler: (sources: ImportSource[]) => void): () => void {
    const over = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
    };
    const drop = (e: DragEvent) => {
      if (!e.dataTransfer?.files.length) return;
      e.preventDefault();
      handler(Array.from(e.dataTransfer.files, (file) => ({ kind: "file" as const, file, name: file.name })));
    };
    window.addEventListener("dragover", over);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("drop", drop);
    };
  }

  /** 讀規格：圖片用瀏覽器解出尺寸；影音用 mediabunny，並檢查瀏覽器解不解得了 */
  async probe(source: ImportSource, id: string): Promise<Media> {
    if (source.kind !== "file") throw new UnsupportedMediaError("The browser version imports files only.");
    const { file } = source;
    const kind = classifyFile(file.name, file.type);
    if (!kind) throw new UnsupportedMediaError(`${file.name} isn't a video, image or audio file.`);
    let media: Media;
    if (kind === "image") {
      const bitmap = await createImageBitmap(file).catch(() => null);
      if (!bitmap) throw new UnsupportedMediaError(`Can't read the image ${file.name}.`);
      media = { id, name: file.name, handleKey: id, kind, duration: IMAGE_DURATION, width: bitmap.width, height: bitmap.height, hasAlpha: true };
      bitmap.close();
    } else {
      const mb = await loadMediabunny();
      const input = new mb.Input({ source: new mb.BlobSource(file), formats: mb.ALL_FORMATS });
      try {
        const format = await input.getFormat().catch(() => null);
        if (!format) throw new UnsupportedMediaError(`Can't read ${file.name}.`);
        const video = kind === "video" ? await input.getPrimaryVideoTrack() : null;
        const audio = await input.getPrimaryAudioTrack();
        const actual = video ? "video" : audio ? "audio" : null;
        if (!actual) throw new UnsupportedMediaError(`${file.name} has no video or audio.`);
        const problem = webSupport({ kind: actual, container: containerName(mb, format), videoCodec: video ? await video.getCodec() : null, audioCodec: audio ? await audio.getCodec() : null });
        if (problem) throw new UnsupportedMediaError(problem);
        const stats = video ? await video.computePacketStats(100) : null;
        media = {
          id, name: file.name, handleKey: id, kind: actual,
          duration: await input.computeDuration(),
          ...(video ? { width: await video.getDisplayWidth(), height: await video.getDisplayHeight(), fps: stats?.averagePacketRate, hasAlpha: await video.canBeTransparent() } : {}),
          audio: audio !== null,
        };
      } finally {
        input.dispose();
      }
    }
    this.files.set(id, { file, url: URL.createObjectURL(file) });
    return media;
  }

  /** 縮圖（影片取 1 秒處、圖片縮小）與音量包絡；網頁版不做代理檔，預覽直接用原檔（§5.21） */
  async prepare(media: Media, onProgress: (ratio: number) => void): Promise<Prepared> {
    const entry = media.handleKey ? this.files.get(media.handleKey) : undefined;
    if (!entry) return {};
    const result: Prepared = {};
    if (media.kind === "image") {
      const bitmap = await createImageBitmap(entry.file, { resizeWidth: THUMB_WIDTH, resizeQuality: "medium" });
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
      bitmap.close();
      result.thumbnailUrl = await canvasToUrl(canvas);
      onProgress(1);
      return result;
    }
    const mb = await loadMediabunny();
    const input = new mb.Input({ source: new mb.BlobSource(entry.file), formats: mb.ALL_FORMATS });
    try {
      const video = await input.getPrimaryVideoTrack();
      if (video) {
        const frame = await new mb.CanvasSink(video, { width: THUMB_WIDTH, poolSize: 1 }).getCanvas(Math.min(1, media.duration / 2));
        if (frame) result.thumbnailUrl = await canvasToUrl(frame.canvas);
      }
      const audio = await input.getPrimaryAudioTrack();
      if (audio) {
        const builder = new EnvelopeBuilder(await audio.getSampleRate());
        for await (const { buffer, timestamp } of new mb.AudioBufferSink(audio).buffers()) {
          // 多聲道平均成單聲道
          const mono = new Float32Array(buffer.length);
          for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            const data = buffer.getChannelData(ch);
            for (let i = 0; i < data.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
          }
          builder.push(mono);
          onProgress(Math.min(1, timestamp / media.duration));
        }
        result.envelope = builder.finish();
      }
    } finally {
      input.dispose();
    }
    onProgress(1);
    return result;
  }

  /** 釋放匯入檔案的 blob 網址 */
  release(media: Media): void {
    const entry = media.handleKey ? this.files.get(media.handleKey) : undefined;
    if (!entry) return;
    URL.revokeObjectURL(entry.url);
    this.files.delete(media.handleKey!);
  }

  /** 開發伺服器以 /samples/ 提供 repo 的 samples/（vite.samples.ts） */
  async demoMediaRoot(): Promise<string | null> {
    return "samples";
  }

  async makeMezzanine(_mediaId: string): Promise<string> {
    throw new NotImplementedError("makeMezzanine");
  }

  async extractAsrAudio(_mediaId: string): Promise<Blob> {
    throw new NotImplementedError("extractAsrAudio");
  }

  /** 網頁版不做聲音分離（D28），介面應先依 capabilities 擋掉；直接呼叫時明確拒絕 */
  async separateVocals(_mediaId: string): Promise<{ vocalsId: string; backgroundId: string }> {
    throw new Error("Vocal separation is available in the Windows app");
  }
}
