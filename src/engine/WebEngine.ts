import type { InputFormat } from "mediabunny";
import { EnvelopeBuilder } from "../audio/envelope";
import type { Media } from "../core/model";
import { TIERS, chunkCount, indicesInChunk, type DoneMap } from "../media/thumbs";
import { IMAGE_DURATION } from "../core/media";
import { NotImplementedError, UnsupportedMediaError, type Engine, type ExportTarget, type ImportSource, type Prepared, type ProjectLocation } from "./Engine";
import { classifyFile, webSupport } from "./webFormats";
import { downsample, encodeWav } from "../asr/wav";
import { ensurePermission, getHandle, putHandle } from "./handleStore";

/** File System Access 的選取器（DOM 型別還沒有） */
interface Pickers {
  showDirectoryPicker?: (o?: { mode?: "read" | "readwrite"; id?: string }) => Promise<FileSystemDirectoryHandle>;
  showOpenFilePicker?: (o?: { multiple?: boolean; types?: { description: string; accept: Record<string, string[]> }[] }) => Promise<FileSystemFileHandle[]>;
}
const pickers = (): Pickers => (typeof window === "undefined" ? {} : (window as unknown as Pickers));

/** 專案資料夾的副檔名與裡面的檔案（D41） */
const PROJECT_EXT = ".wordblade";
const PROJECT_FILE = "project.json";
const DATA_DIR = ".data";

/** 專案名稱：資料夾名去掉 .wordblade */
function projectName(dirName: string): string {
  return dirName.endsWith(PROJECT_EXT) ? dirName.slice(0, -PROJECT_EXT.length) : dirName;
}

/** 讀專案資料夾裡的 project.json；沒有回 null */
async function readProjectFile(dir: FileSystemDirectoryHandle): Promise<string | null> {
  try {
    return await (await (await dir.getFileHandle(PROJECT_FILE)).getFile()).text();
  } catch {
    return null;
  }
}

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

/** FNV-1a 32 位元雜湊（縮圖快取的資料夾名稱） */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** OPFS 裡的檔案是否存在 */
async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

/** 網頁版：Chrome／Edge 的 WebCodecs、File System Access、OPFS（§5.21） */
export class WebEngine implements Engine {
  readonly kind = "web" as const;
  readonly capabilities = { vocalSeparation: false, anyFormatImport: false };
  /** 匯入的檔案：handleKey → File 與預覽用的 blob 網址（重新整理後就沒有；開著專案資料夾時另把 handle 存進 IndexedDB） */
  private readonly files = new Map<string, { file: File; url: string }>();
  /** 開著專案資料夾（選檔改用 showOpenFilePicker，才拿得到能記住的 handle） */
  private folderOpen = false;

  /** 匯入的檔案用 blob 網址；專案內的相對路徑（開發伺服器以 /samples/ 提供）照舊 */
  mediaUrl(media: Media): string {
    if (media.handleKey) return this.files.get(media.handleKey)?.url ?? "";
    const path = media.proxyPath ?? media.path ?? "";
    return path.startsWith("/") || /^[a-z]+:/i.test(path) ? path : `/${path}`;
  }

  /**
   * 選檔。開著專案資料夾時用 showOpenFilePicker（拿得到 handle，重開專案時找得回素材）；
   * 其他情況用隱藏的 <input type=file>（e2e 的 filechooser 也走這條）。
   */
  async pickFiles(): Promise<ImportSource[]> {
    const picker = pickers().showOpenFilePicker;
    if (this.folderOpen && picker) {
      try {
        const handles = await picker({ multiple: true, types: [{ description: "Video, image or audio", accept: { "video/*": [".mp4", ".mov", ".webm"], "image/*": [], "audio/*": [".m4a", ".mp3", ".wav"] } }] });
        return Promise.all(handles.map(async (handle) => ({ kind: "file" as const, file: await handle.getFile(), name: handle.name, handle })));
      } catch (e) {
        if ((e as DOMException).name === "AbortError") return [];
        throw e;
      }
    }
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
      // 有 getAsFileSystemHandle（Chrome／Edge）就順便拿 handle，重開專案時找得回素材；要在事件當下呼叫
      const items = Array.from(e.dataTransfer.items).filter((i) => i.kind === "file");
      const files = Array.from(e.dataTransfer.files);
      const handles = items.map((i) => (i as unknown as { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> }).getAsFileSystemHandle?.());
      void Promise.all(handles.map((h) => h?.catch(() => null) ?? null)).then((hs) => handler(files.map((file, k) => {
        const h = hs[k];
        return { kind: "file" as const, file, name: file.name, ...(h?.kind === "file" ? { handle: h as FileSystemFileHandle } : {}) };
      })));
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
    // 有 handle 就記住（鍵＝handleKey），重開專案時 locateMedia 拿得回來
    if (source.handle) await putHandle(id, source.handle).catch(() => undefined);
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

  /** 範例專案：靜態網站的 /sample/project.json */
  async openSample(): Promise<{ root: string; text: string } | null> {
    const res = await fetch("/sample/project.json").catch(() => null);
    return res?.ok ? { root: "sample", text: await res.text() } : null;
  }

  /** 開發用（範例專案打包腳本）：匯入或產生的檔案的位元組；不是這裡管的回 null */
  async fileBytes(handleKey: string): Promise<Uint8Array | null> {
    const entry = this.files.get(handleKey);
    return entry ? new Uint8Array(await entry.file.arrayBuffer()) : null;
  }

  async makeMezzanine(_mediaId: string): Promise<string> {
    throw new NotImplementedError("makeMezzanine");
  }

  /** 匯入的檔案給 File；示範專案的素材（開發伺服器 /samples/）給網址 */
  async exportSource(media: Media): Promise<Blob | string> {
    const entry = media.handleKey ? this.files.get(media.handleKey) : undefined;
    if (entry) return entry.file;
    const path = media.mezzaninePath ?? media.path ?? "";
    if (!path) throw new Error(`Media ${media.name ?? media.id} has no source`);
    return path.startsWith("/") || /^[a-z]+:/i.test(path) ? path : `/${path}`;
  }

  /**
   * 有存檔對話框（Chrome／Edge）就讓使用者選位置；沒有（或 localStorage `wordblade.exportToOpfs` 為 "1"，e2e 用）
   * 就寫進 OPFS 的 exports/ 資料夾。SRT：選了位置的話以下載給出（對話框要使用者手勢，匯出完已經沒有了），OPFS 則寫在同一資料夾。
   */
  async openExportTarget(suggestedName: string): Promise<ExportTarget | null> {
    const picker = (window as unknown as { showSaveFilePicker?: (o: unknown) => Promise<FileSystemFileHandle> }).showSaveFilePicker;
    let toOpfs = !picker;
    try {
      if (localStorage.getItem("wordblade.exportToOpfs") === "1") toOpfs = true;
    } catch { /* 沒有 localStorage 就照預設 */ }
    let handle: FileSystemFileHandle;
    let remove: () => Promise<void>;
    let sibling: (name: string, data: string | Uint8Array) => Promise<string>;
    if (toOpfs) {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports", { create: true });
      handle = await dir.getFileHandle(suggestedName, { create: true });
      remove = () => dir.removeEntry(suggestedName).catch(() => undefined);
      sibling = async (name, data) => {
        const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await w.write(data as string | Uint8Array<ArrayBuffer>);
        await w.close();
        return `OPFS exports/${name}`;
      };
    } else {
      try {
        handle = await picker!({ suggestedName, types: [{ description: "MP4 video", accept: { "video/mp4": [".mp4"] } }] });
      } catch (e) {
        if ((e as DOMException).name === "AbortError") return null;
        throw e;
      }
      // 使用者選的檔案刪不掉（沒有父資料夾的權限），取消時改成清空
      remove = async () => {
        const w = await handle.createWritable();
        await w.close();
      };
      sibling = async (name, data) => {
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([data as string | Uint8Array<ArrayBuffer>], { type: typeof data === "string" ? "text/plain" : "application/octet-stream" }));
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
        return `download ${name}`;
      };
    }
    const writable = await handle.createWritable();
    const base = handle.name.replace(/\.[^.]+$/, "");
    return {
      name: toOpfs ? `OPFS exports/${handle.name}` : handle.name,
      write: (position, data) => writable.write({ type: "write", position, data: data as Uint8Array<ArrayBuffer> }),
      close: () => writable.close(),
      abort: async () => {
        await writable.abort().catch(() => undefined);
        await remove();
      },
      writeSibling: (ext, data) => sibling(`${base}.${ext}`, data),
    };
  }

  /** mediabunny 解出 [start, end) 的聲音，多聲道平均成單聲道、降到 16 kHz、編 WAV */
  async extractAsrAudio(media: Media, start: number, end: number): Promise<Uint8Array> {
    const mb = await loadMediabunny();
    const src = await this.exportSource(media);
    const input = new mb.Input({ source: typeof src === "string" ? new mb.UrlSource(src) : new mb.BlobSource(src), formats: mb.ALL_FORMATS });
    try {
      const track = await input.getPrimaryAudioTrack();
      if (!track) throw new Error(`Media ${media.name ?? media.id} has no audio`);
      const rate = await track.getSampleRate();
      const mono = new Float32Array(Math.max(0, Math.round((end - start) * rate)));
      for await (const sample of new mb.AudioSampleSink(track).samples(start, end)) {
        const frames = sample.numberOfFrames;
        const at = Math.round((sample.timestamp - start) * rate);
        const tmp = new Float32Array(frames);
        for (let ch = 0; ch < sample.numberOfChannels; ch++) {
          sample.copyTo(tmp, { planeIndex: ch, format: "f32-planar" });
          for (let i = Math.max(0, -at); i < frames && at + i < mono.length; i++) mono[at + i] += tmp[i] / sample.numberOfChannels;
        }
        sample.close();
      }
      return encodeWav(downsample(mono, rate));
    } finally {
      input.dispose();
    }
  }

  /** 網頁版不做聲音分離（D28），介面應先依 capabilities 擋掉；直接呼叫時明確拒絕 */
  /**
   * 專案資料夾（D41）：有 File System Access 的瀏覽器（Chrome／Edge）可用。
   * 資料夾的 handle 存進 IndexedDB，ProjectLocation.dir 是它的鍵；沒有 FS Access 時退回瀏覽器裡的自動存檔。
   */
  readonly projectFolders = typeof pickers().showDirectoryPicker === "function";

  /** 選資料夾；取消回 null */
  private async pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
    try {
      return await pickers().showDirectoryPicker!({ mode: "readwrite", id: "wordblade-project" });
    } catch (e) {
      if ((e as DOMException).name === "AbortError") return null;
      throw e;
    }
  }

  /**
   * 記住開著的專案資料夾，回傳位置。鍵用資料夾名：同一個專案再開不會在「最近開啟」多一筆；
   * 不同位置的同名專案會共用鍵（以最近開的為準），瀏覽器看不到完整路徑，只能這樣取捨。
   */
  private async remember(dir: FileSystemDirectoryHandle): Promise<ProjectLocation> {
    const key = `project:${dir.name}`;
    await putHandle(key, dir);
    this.folderOpen = true;
    return { name: projectName(dir.name), dir: key };
  }

  /** 新專案：選放在哪裡，建 <名稱>.wordblade（含 .data） */
  async createProject(name: string): Promise<ProjectLocation | null> {
    const parent = await this.pickDirectory();
    if (!parent) return null;
    const dir = await parent.getDirectoryHandle(`${name}${PROJECT_EXT}`, { create: true });
    await dir.getDirectoryHandle(DATA_DIR, { create: true });
    return this.remember(dir);
  }

  /** 開舊專案：選 .wordblade 資料夾（裡面要有 project.json） */
  async openProject(): Promise<{ location: ProjectLocation; text: string } | null> {
    const dir = await this.pickDirectory();
    if (!dir) return null;
    const text = await readProjectFile(dir);
    if (text === null) throw new Error(`${dir.name} has no ${PROJECT_FILE} — pick a .wordblade project folder.`);
    return { location: await this.remember(dir), text };
  }

  /** 最近開啟：從 IndexedDB 拿資料夾、確認權限（要在使用者手勢裡）；找不到或沒權限回 null */
  async reopenProject(location: ProjectLocation): Promise<{ location: ProjectLocation; text: string } | null> {
    const dir = await getHandle<FileSystemDirectoryHandle>(location.dir).catch(() => undefined);
    if (!dir || !(await ensurePermission(dir, "readwrite"))) return null;
    const text = await readProjectFile(dir);
    if (text === null) return null;
    this.folderOpen = true;
    return { location: { name: projectName(dir.name), dir: location.dir }, text };
  }

  /** 寫 project.json（createWritable 先寫暫存、close 時才換掉，不會寫壞） */
  async writeProject(location: ProjectLocation, text: string): Promise<void> {
    const dir = await getHandle<FileSystemDirectoryHandle>(location.dir);
    if (!dir) throw new NotImplementedError("writeProject (the project folder is no longer available)");
    const w = await (await dir.getFileHandle(PROJECT_FILE, { create: true })).createWritable();
    await w.write(text);
    await w.close();
  }

  /** 網頁版不算指紋（找素材靠記住的 handle） */
  async mediaFingerprint(): Promise<string | undefined> {
    return undefined;
  }

  /** 網頁版沒有錄音退路（被擋就提示） */
  readonly recorderFallback = null;

  /** 開著的專案資料夾（產生的檔案寫進它的 .data/generated/） */
  private project: ProjectLocation | null = null;

  setProjectLocation(location: ProjectLocation | null): void {
    this.project = location;
    this.folderOpen = location !== null;
  }

  /** 專案 .data 裡 rel 的上一層資料夾與檔名（create：沒有就建） */
  private async dataFile(location: ProjectLocation, rel: string, create: boolean): Promise<{ dir: FileSystemDirectoryHandle; name: string }> {
    let dir = await getHandle<FileSystemDirectoryHandle>(location.dir);
    if (!dir) throw new Error("The project folder is no longer available");
    const segs = [DATA_DIR, ...rel.split("/")];
    if (segs.some((s) => !s || s === "." || s === "..")) throw new Error(`bad data path: ${rel}`);
    for (const seg of segs.slice(0, -1)) dir = await dir.getDirectoryHandle(seg, { create });
    return { dir, name: segs[segs.length - 1] };
  }

  /** 寫 .data 裡的文字檔 */
  async writeData(location: ProjectLocation, rel: string, text: string): Promise<void> {
    const { dir, name } = await this.dataFile(location, rel, true);
    const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
    await w.write(text);
    await w.close();
  }

  /** 讀 .data 裡的文字檔；沒有回 null */
  async readData(location: ProjectLocation, rel: string): Promise<string | null> {
    try {
      const { dir, name } = await this.dataFile(location, rel, false);
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return null;
    }
  }

  /** 重新連結：使用者替找不到的素材選了檔案，換掉記住的 handle 與記憶體裡的檔案 */
  async adoptFile(media: Media, source: ImportSource): Promise<boolean> {
    if (source.kind !== "file" || !media.handleKey) return false;
    const old = this.files.get(media.handleKey);
    if (old) URL.revokeObjectURL(old.url);
    this.files.set(media.handleKey, { file: source.file, url: URL.createObjectURL(source.file) });
    if (source.handle) await putHandle(media.handleKey, source.handle).catch(() => undefined);
    return true;
  }

  /** 找回素材：記憶體裡有就用；否則從 IndexedDB 拿記住的 handle（要有讀取權限） */
  async locateMedia(media: Media): Promise<Media | null> {
    if (!media.handleKey) return null;
    if (this.files.has(media.handleKey)) return media;
    const handle = await getHandle<FileSystemFileHandle>(media.handleKey).catch(() => undefined);
    if (!handle || !(await ensurePermission(handle, "read"))) return null;
    try {
      const file = await handle.getFile();
      this.files.set(media.handleKey, { file, url: URL.createObjectURL(file) });
      return media;
    } catch {
      return null;
    }
  }

  /** 縮圖快取的鍵：匯入的檔案用「檔名＋大小＋修改時間」，示範素材用路徑；都沒有回 null */
  private thumbKey(media: Media): string | null {
    const entry = media.handleKey ? this.files.get(media.handleKey) : undefined;
    if (entry) return fnv1a(`${entry.file.name}|${entry.file.size}|${entry.file.lastModified}`);
    return media.path ? fnv1a(media.path) : null;
  }

  /** 縮圖快取的資料夾：OPFS thumbs/<鍵>/t<層>/ */
  private async thumbDir(media: Media, tier: number, create: boolean): Promise<FileSystemDirectoryHandle | null> {
    const key = this.thumbKey(media);
    if (!key) return null;
    try {
      const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("thumbs", { create });
      return await (await root.getDirectoryHandle(key, { create })).getDirectoryHandle(`t${tier}`, { create });
    } catch {
      return null;
    }
  }

  /** 縮圖序列的一段：mediabunny 依時間點解出畫面、縮成這一層的寬度、存 JPEG 到 OPFS，最後寫完成標記 */
  async makeThumbs(media: Media, tier: number, chunk: number): Promise<void> {
    const entry = media.handleKey ? this.files.get(media.handleKey) : undefined;
    const dir = await this.thumbDir(media, tier, true);
    if (!dir) throw new Error("No cache folder for thumbnails");
    const mb = await loadMediabunny();
    const source = entry ? new mb.BlobSource(entry.file) : new mb.UrlSource(this.mediaUrl(media));
    const input = new mb.Input({ source, formats: mb.ALL_FORMATS });
    try {
      const video = await input.getPrimaryVideoTrack();
      if (!video) throw new Error("No video track");
      const { interval, width } = TIERS[tier];
      const indices = indicesInChunk(tier, chunk, media.duration);
      const sink = new mb.CanvasSink(video, { width, poolSize: 2 });
      let n = 0;
      for await (const frame of sink.canvasesAtTimestamps(indices.map((i) => i * interval))) {
        const index = indices[n++];
        if (!frame) continue;
        const canvas = frame.canvas;
        const blob = canvas instanceof OffscreenCanvas
          ? await canvas.convertToBlob({ type: "image/jpeg", quality: 0.75 })
          : await new Promise<Blob>((ok, fail) => canvas.toBlob((b) => (b ? ok(b) : fail(new Error("toBlob failed"))), "image/jpeg", 0.75));
        const writable = await (await dir.getFileHandle(`${index}.jpg`, { create: true })).createWritable();
        await writable.write(blob);
        await writable.close();
      }
      const marker = await (await dir.getFileHandle(`c${chunk}.done`, { create: true })).createWritable();
      await marker.close();
    } finally {
      input.dispose();
    }
  }

  /** 各層做好的段：看 OPFS 裡的完成標記 */
  async thumbStatus(media: Media): Promise<DoneMap> {
    return Promise.all(TIERS.map(async (_, tier) => {
      const dir = await this.thumbDir(media, tier, false);
      if (!dir) return [];
      const done: number[] = [];
      for (let c = 0; c < chunkCount(media.duration); c++) if (await exists(dir, `c${c}.done`)) done.push(c);
      return done;
    }));
  }

  /** 一張縮圖的 blob: 網址（呼叫端的快取負責釋放） */
  async thumbUrl(media: Media, tier: number, index: number): Promise<string | null> {
    const dir = await this.thumbDir(media, tier, false);
    if (!dir) return null;
    try {
      return URL.createObjectURL(await (await dir.getFileHandle(`${index}.jpg`)).getFile());
    } catch {
      return null;
    }
  }

  async separateVocals(_mediaId: string): Promise<{ vocalsId: string; backgroundId: string }> {
    throw new Error("Vocal separation is available in the Windows app");
  }

  /**
   * 產生的 WAV：開著專案資料夾時寫進 .data/generated/（帶 handle，重開專案找得回來）；
   * 沒開時包成 File（存在記憶體，重新整理後就沒有）。
   */
  async importGenerated(name: string, bytes: Uint8Array): Promise<ImportSource> {
    const loc = this.project;
    if (loc) {
      try {
        const { dir } = await this.dataFile(loc, "generated/x", true);
        const stem = name.replace(/\.[^.]+$/, "").replace(/[^A-Za-z0-9_-]/g, "-") || "generated";
        let fileName = `${stem}.wav`;
        for (let n = 2; await dir.getFileHandle(fileName).then(() => true, () => false); n++) fileName = `${stem}-${n}.wav`;
        const handle = await dir.getFileHandle(fileName, { create: true });
        const w = await handle.createWritable();
        await w.write(bytes as Uint8Array<ArrayBuffer>);
        await w.close();
        return { kind: "file", file: await handle.getFile(), name: fileName, handle };
      } catch {
        /* 寫不進專案資料夾：退回記憶體 */
      }
    }
    const file = new File([bytes as Uint8Array<ArrayBuffer>], name, { type: "audio/wav" });
    return { kind: "file", file, name };
  }
}
