import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { ENVELOPE_RATE } from "../audio/envelope";
import { IMAGE_DURATION } from "../core/media";
import type { Media } from "../core/model";
import { NotImplementedError, UnsupportedMediaError, type Engine, type ImportSource, type Prepared } from "./Engine";

/** Rust probe_media 回傳的規格 */
interface ProbeInfo {
  kind: Media["kind"];
  duration: number;
  width?: number;
  height?: number;
  fps?: number;
  audio: boolean;
  hasAlpha: boolean;
  videoCodec?: string;
}

/** 選檔對話框的副檔名篩選 */
const FILTERS = [
  { name: "Media", extensions: ["mp4", "mov", "m4v", "mkv", "webm", "avi", "png", "jpg", "jpeg", "webp", "gif", "bmp", "mp3", "wav", "m4a", "aac", "ogg", "opus", "flac"] },
];

/** 路徑取檔名 */
function baseName(path: string): string {
  return path.split(/[\/]/).pop() ?? path;
}

/** Windows 桌面版：重運算交給 Rust 指令層（ffmpeg sidecar、onnxruntime） */
export class DesktopEngine implements Engine {
  readonly kind = "desktop" as const;
  readonly capabilities = { vocalSeparation: true, anyFormatImport: true };
  /** 本機檔案經 Tauri 的 asset 協定給 WebView 讀；有代理檔就用代理檔（§5.21） */
  mediaUrl(media: Media): string {
    const path = media.proxyPath ?? media.path ?? "";
    return path ? convertFileSrc(path) : "";
  }

  async pickFiles(): Promise<ImportSource[]> {
    const picked = await open({ multiple: true, directory: false, filters: FILTERS });
    const paths = picked === null ? [] : Array.isArray(picked) ? picked : [picked];
    return paths.map((path) => ({ kind: "path" as const, path, name: baseName(path) }));
  }

  /** 原生拖放（Windows 上 Tauri 接管了 WebView2 的拖放，HTML5 drop 收不到檔案） */
  onFilesDropped(handler: (sources: ImportSource[]) => void): () => void {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "drop") handler(event.payload.paths.map((path) => ({ kind: "path" as const, path, name: baseName(path) })));
      })
      .then((fn) => (cancelled ? fn() : (unlisten = fn)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }

  /** ffprobe 讀規格（Rust 同時把這個檔放進 asset 協定的允許清單） */
  async probe(source: ImportSource, id: string): Promise<Media> {
    if (source.kind !== "path") throw new UnsupportedMediaError("The Windows app imports files by path.");
    const info = await invoke<ProbeInfo>("probe_media", { path: source.path }).catch((e: unknown) => {
      throw new UnsupportedMediaError(`Can't read ${source.name}: ${String(e)}`);
    });
    return {
      id, name: source.name, path: source.path, kind: info.kind,
      duration: info.kind === "image" ? IMAGE_DURATION : info.duration,
      ...(info.width ? { width: info.width, height: info.height } : {}),
      ...(info.fps ? { fps: info.fps } : {}),
      hasAlpha: info.hasAlpha,
      audio: info.audio,
    };
  }

  /** 縮圖、音量包絡，影片再產生 540p 代理檔（進度以代理檔為主） */
  async prepare(media: Media, onProgress: (ratio: number) => void): Promise<Prepared> {
    const path = media.path;
    if (!path) return {};
    const result: Prepared = {};
    if (media.kind !== "audio") {
      const at = media.kind === "image" ? 0 : Math.min(1, media.duration / 2);
      const jpeg = await invoke<ArrayBuffer>("media_thumbnail", { path, at });
      result.thumbnailUrl = URL.createObjectURL(new Blob([jpeg], { type: "image/jpeg" }));
    }
    if (media.audio) {
      const bytes = await invoke<ArrayBuffer>("media_envelope", { path });
      result.envelope = { rate: ENVELOPE_RATE, rms: new Float32Array(bytes) };
    }
    // 影片產生代理檔：不透明 H.264 MP4、帶透明 VP9 透明 WebM（Q5）；同一支原檔已有代理檔就直接重用
    if (media.kind === "video") {
      const unlisten = await listen<{ mediaId: string; ratio: number }>("proxy-progress", (e) => {
        if (e.payload.mediaId === media.id) onProgress(e.payload.ratio);
      });
      try {
        result.proxyPath = await invoke<string>("make_proxy", { mediaId: media.id, path, duration: media.duration, fps: media.fps ?? null, alpha: media.hasAlpha === true });
      } finally {
        unlisten();
      }
    }
    onProgress(1);
    return result;
  }

  /** 桌面版沒有要釋放的資源（檔案在磁碟上） */
  release(_media: Media): void {}

  async demoMediaRoot(): Promise<string | null> {
    return invoke<string | null>("find_samples_dir");
  }

  async makeMezzanine(_mediaId: string): Promise<string> {
    throw new NotImplementedError("makeMezzanine");
  }

  async extractAsrAudio(_mediaId: string): Promise<Blob> {
    throw new NotImplementedError("extractAsrAudio");
  }

  async separateVocals(_mediaId: string): Promise<{ vocalsId: string; backgroundId: string }> {
    throw new NotImplementedError("separateVocals");
  }
}
