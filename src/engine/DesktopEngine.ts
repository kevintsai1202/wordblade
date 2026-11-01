import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open, save } from "@tauri-apps/plugin-dialog";
import { ENVELOPE_RATE } from "../audio/envelope";
import { pcm16ToWav } from "../asr/wav";
import { IMAGE_DURATION } from "../core/media";
import type { Media } from "../core/model";
import { CHUNK, TIERS, chunkCount, indicesInChunk, type DoneMap } from "../media/thumbs";
import { NotImplementedError, UnsupportedMediaError, type Engine, type ExportTarget, type ImportSource, type Prepared, type ProjectLocation } from "./Engine";

/** 資料夾路徑 → 專案名稱（最後一段去掉 .wordblade） */
function projectName(dir: string): string {
  const last = dir.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? dir;
  return last.replace(/\.wordblade$/i, "");
}

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
  /** 聲音分離（P1-10）還沒實作：旗標維持 false，等 separateVocals 做好再打開 */
  readonly capabilities = { vocalSeparation: false, anyFormatImport: true };
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
    // 素材只記連結（原檔路徑），不複製進專案（2026-11-01 開發者決定，同達文西）
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

  /** 各原檔的縮圖資料夾（thumbs_status 回傳；組縮圖網址用） */
  private readonly thumbBase = new Map<string, string>();

  /**
   * 縮圖序列的一段（D39）：第 0 層從原檔只解關鍵幀（匯入時代理檔還沒做，這樣最快）；
   * 細層有代理檔就從代理檔解（540p，關鍵幀每秒一個）。
   */
  async makeThumbs(media: Media, tier: number, chunk: number): Promise<void> {
    if (!media.path) throw new Error("No file path");
    const { interval, width } = TIERS[tier];
    const start = chunk * CHUNK;
    const indices = indicesInChunk(tier, chunk, media.duration);
    await invoke("thumbs_make", {
      path: media.path, source: tier > 0 && media.proxyPath ? media.proxyPath : media.path, tier, chunk,
      start, duration: Math.max(interval, Math.min(CHUNK, media.duration - start)), interval, width,
      firstIndex: indices[0] ?? 0, count: indices.length, keyOnly: tier === 0,
    });
  }

  /** 各層做好的段（Rust 看完成標記），並記下資料夾 */
  async thumbStatus(media: Media): Promise<DoneMap> {
    if (!media.path) return TIERS.map(() => []);
    const status = await invoke<{ base: string; done: number[][] }>("thumbs_status", { path: media.path, tiers: TIERS.length, chunks: chunkCount(media.duration) });
    this.thumbBase.set(media.path, status.base);
    return status.done;
  }

  /** 縮圖檔的 asset 協定網址（資料夾在啟動時已放行） */
  async thumbUrl(media: Media, tier: number, index: number): Promise<string | null> {
    const base = media.path ? this.thumbBase.get(media.path) : undefined;
    return base ? convertFileSrc(`${base}\\t${tier}\\${index}.jpg`) : null;
  }

  /** 專案資料夾（D41）：桌面版一律可用 */
  readonly projectFolders = true;

  /** 新專案：選父資料夾，Rust 建 <名稱>.wordblade\ */
  async createProject(name: string): Promise<ProjectLocation | null> {
    const parent = await open({ directory: true, multiple: false, title: "Where to put the project folder" });
    if (typeof parent !== "string") return null;
    const dir = await invoke<string>("project_create", { parent, name });
    return { name: projectName(dir), dir };
  }

  /** 開舊專案：選 .wordblade 資料夾 */
  async openProject(): Promise<{ location: ProjectLocation; text: string } | null> {
    const picked = await open({ directory: true, multiple: false, title: "Open a .wordblade project folder" });
    if (typeof picked !== "string") return null;
    try {
      const [dir, text] = await invoke<[string, string]>("project_read", { dir: picked });
      return { location: { name: projectName(dir), dir }, text };
    } catch {
      throw new Error(`${picked} isn't a WordBlade project — pick the .wordblade folder (it has project.json inside).`);
    }
  }

  /** 依路徑重新開（最近開啟） */
  async reopenProject(location: ProjectLocation): Promise<{ location: ProjectLocation; text: string } | null> {
    try {
      const [dir, text] = await invoke<[string, string]>("project_read", { dir: location.dir });
      return { location: { name: projectName(dir), dir }, text };
    } catch {
      return null;
    }
  }

  /** 寫 project.json */
  async writeProject(location: ProjectLocation, text: string): Promise<void> {
    await invoke("project_write", { dir: location.dir, text });
  }

  /** 開著的專案資料夾（產生的檔案寫進它的 .data\generated\） */
  private project: ProjectLocation | null = null;

  /** 錄音退路：Rust 用 PowerShell 驅動 Windows 內建錄音機（scripts/recorder/sound-recorder.ps1） */
  readonly recorderFallback = {
    start: async (): Promise<void> => {
      await invoke<number>("recorder_start");
    },
    stop: async (): Promise<ImportSource> => {
      const { path } = await invoke<{ path: string }>("recorder_stop", { projectDir: this.project?.dir ?? null });
      return { kind: "path", path, name: baseName(path) };
    },
  };

  setProjectLocation(location: ProjectLocation | null): void {
    this.project = location;
  }

  /** 寫 .data 裡的文字檔（Rust 檢查路徑跳不出 .data） */
  async writeData(location: ProjectLocation, rel: string, text: string): Promise<void> {
    await invoke("project_data_write", { dir: location.dir, rel, text });
  }

  /** 讀 .data 裡的文字檔 */
  async readData(location: ProjectLocation, rel: string): Promise<string | null> {
    return invoke<string | null>("project_data_read", { dir: location.dir, rel }).catch(() => null);
  }

  /** Windows 版重新連結走路徑（locateMedia），不用這個 */
  async adoptFile(): Promise<string | null> {
    return null;
  }

  /** 素材指紋（Rust 讀頭尾） */
  async mediaFingerprint(media: Media): Promise<string | undefined> {
    return media.path ? invoke<string>("media_fingerprint", { path: media.path }).catch(() => undefined) : undefined;
  }

  /** 依序找素材（Rust 檢查存在與指紋並放行 asset 協定） */
  async locateMedia(media: Media, candidates: string[], fingerprint?: string): Promise<Media | null> {
    const found = await invoke<string | null>("media_locate", { candidates, fingerprint: fingerprint ?? null });
    return found ? { ...media, path: found } : null;
  }

  /** 桌面版沒有要釋放的資源（檔案在磁碟上） */
  release(_media: Media): void {}

  async demoMediaRoot(): Promise<string | null> {
    return invoke<string | null>("find_samples_dir");
  }

  /** 範例專案：Rust 找安裝資料夾（或 repo 的 public\sample\）並放行讀取，再經 asset 協定讀 project.json */
  async openSample(): Promise<{ root: string; text: string } | null> {
    const root = await invoke<string | null>("find_sample_dir");
    if (!root) return null;
    const res = await fetch(convertFileSrc(`${root}\\project.json`)).catch(() => null);
    return res?.ok ? { root, text: await res.text() } : null;
  }

  async makeMezzanine(_mediaId: string): Promise<string> {
    throw new NotImplementedError("makeMezzanine");
  }

  /** 原檔（WebCodecs 解不了的用中間檔）的 asset 網址；mediabunny 用 Range 分段讀 */
  async exportSource(media: Media): Promise<Blob | string> {
    const path = media.mezzaninePath ?? media.path;
    if (!path) throw new Error(`Media ${media.name ?? media.id} has no source`);
    return convertFileSrc(path);
  }

  /** 存檔對話框選位置，Rust 分塊寫入（raw body）；SRT 寫在同一個資料夾、同檔名 */
  async openExportTarget(suggestedName: string): Promise<ExportTarget | null> {
    const path = await save({ defaultPath: suggestedName, filters: [{ name: "MP4 video", extensions: ["mp4"] }] });
    if (!path) return null;
    const id = await invoke<number>("export_open", { path });
    return {
      name: path,
      write: (position, data) => invoke("export_write", data, { headers: { "x-export-id": String(id), "x-export-pos": String(position) } }),
      close: () => invoke("export_close", { id }),
      abort: () => invoke("export_abort", { id }),
      writeSibling: async (ext, data) => {
        const sibling = path.replace(/\.[^.\/]+$/, "") + `.${ext}`;
        if (typeof data === "string") {
          await invoke("write_text_file", { path: sibling, text: data });
        } else {
          // 二進位（縮圖 PNG）：沿用匯出的分塊寫入
          const sid = await invoke<number>("export_open", { path: sibling });
          await invoke("export_write", data, { headers: { "x-export-id": String(sid), "x-export-pos": "0" } });
          await invoke("export_close", { id: sid });
        }
        return sibling;
      },
    };
  }

  /** ffmpeg 解成 16 kHz 單聲道 s16le，再補 WAV 檔頭 */
  async extractAsrAudio(media: Media, start: number, end: number): Promise<Uint8Array> {
    if (!media.path) throw new Error(`Media ${media.name ?? media.id} has no source`);
    const pcm = await invoke<ArrayBuffer>("asr_pcm", { path: media.path, start, duration: end - start });
    return pcm16ToWav(new Uint8Array(pcm));
  }

  async separateVocals(_mediaId: string): Promise<{ vocalsId: string; backgroundId: string }> {
    throw new NotImplementedError("separateVocals");
  }

  /**
   * 產生的 WAV 寫進開著的專案的 .data\generated\（沒開專案時寫進 app 資料夾的 generated/；Rust write_generated，
   * raw body 傳位元組，不經 JSON），回傳路徑給一般匯入流程。路徑放標頭要先編碼（標頭只能 ASCII）。
   */
  async importGenerated(name: string, bytes: Uint8Array): Promise<ImportSource> {
    const headers: Record<string, string> = { "x-generated-name": name };
    if (this.project) headers["x-project-dir"] = encodeURIComponent(this.project.dir);
    const path = await invoke<string>("write_generated", bytes, { headers });
    return { kind: "path", path, name: baseName(path) };
  }
}
