// 平台相關功能的介面（spec §3、D21）。
// 介面、TS 核心、合成器、沙盒只寫一份；讀寫檔、代理檔、中間檔、抽 ASR 音訊、聲音分離、錄音
// 這些跟平台有關的事收在 Engine 後面，由 DesktopEngine（Tauri＋Rust）與 WebEngine（瀏覽器 API）各自實作。

import type { Envelope } from "../audio/envelope";
import type { Media } from "../core/model";
import type { DoneMap } from "../media/thumbs";

/** 要匯入的檔案：Windows 版是路徑，網頁版是 File */
export type ImportSource = ({ kind: "path"; path: string; name: string } | { kind: "file"; file: File; name: string; handle?: FileSystemFileHandle }) & {
  /** 匯入時就標上的用途（材質圖："texture"，素材庫頁籤不列）；一般匯入沒有 */
  role?: Media["role"];
};

/** 匯入後的背景準備結果 */
export interface Prepared {
  /** 素材庫的縮圖網址（blob: 或 data:） */
  thumbnailUrl?: string;
  /** 音量包絡（有聲素材才有）：波形與配樂壓低用 */
  envelope?: Envelope;
  /** 預覽用代理檔的路徑（Windows 版的影片才有）；呼叫端記進 Media.proxyPath */
  proxyPath?: string;
}

/** 這個檔案不能匯入（格式不支援等）；訊息直接給使用者看 */
export class UnsupportedMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedMediaError";
  }
}

/** 聲音分離的進度：下載模型或分離，比例 0～1 */
export interface SeparationProgress {
  stage: "download" | "separate";
  ratio: number;
}

/** 聲音分離的結果：兩個衍生檔（交給 importSources 變成素材）與診斷資訊 */
export interface SeparationResult {
  vocals: ImportSource;
  background: ImportSource;
  /** 推論用的執行提供者（"directml"、"cpu"，快取命中是 "cache"） */
  provider: string;
  /** 分離花的秒數（不含下載；快取命中是 0） */
  seconds: number;
}

/** 使用者取消了聲音分離 */
export class SeparationCancelled extends Error {
  constructor() {
    super("Separation cancelled");
    this.name = "SeparationCancelled";
  }
}

/** 這個平台能做的事；介面依此決定要不要顯示功能或提示改用 Windows 版 */
export interface EngineCapabilities {
  /** 聲音分離（D28：只有 Windows 版） */
  vocalSeparation: boolean;
  /** 任何 ffmpeg 讀得到的格式都能匯入；false 時只吃 H.264／AAC 的 MP4、MOV（§5.21） */
  anyFormatImport: boolean;
}

/**
 * 匯出的寫入目標（§5.4）：mediabunny 依位置分塊寫入（MP4 收尾時會回頭改檔頭，所以要能指定位置）。
 * Windows 版是使用者選的檔案（Rust 分塊寫），網頁版是 File System Access 的可寫串流（沒有存檔對話框時寫進 OPFS）。
 */
export interface ExportTarget {
  /** 顯示給使用者的位置（路徑或檔名） */
  readonly name: string;
  /** 在 position 寫入 data */
  write(position: number, data: Uint8Array): Promise<void>;
  /** 寫完收尾 */
  close(): Promise<void>;
  /** 取消：關掉並刪除寫了一半的檔案 */
  abort(): Promise<void>;
  /** 同名、換副檔名的檔案（SRT、發佈包的 publish.md 與縮圖 PNG）；回傳存到哪裡（網頁版是下載） */
  writeSibling(ext: string, data: string | Uint8Array): Promise<string>;
}

/** 開著的專案資料夾（D41）：桌面版是資料夾路徑；網頁版是存在 IndexedDB 的資料夾權限的鍵 */
export interface ProjectLocation {
  /** 專案名稱（資料夾名去掉 .wordblade） */
  name: string;
  /** 桌面：<父資料夾>\<名稱>.wordblade 的絕對路徑；網頁：資料夾權限的鍵 */
  dir: string;
}

/** 平台相關功能；各方法的細節在對應的開發日補上 */
export interface Engine {
  /** 執行環境：Windows 桌面版或網頁版 */
  readonly kind: "desktop" | "web";
  readonly capabilities: EngineCapabilities;
  /** 預覽用的素材網址（<video>／<audio> 的 src）：有代理檔就用代理檔（§5.21） */
  mediaUrl(media: Media): string;
  /** 開選檔對話框（影片、圖片、聲音，可複選）；取消回空陣列 */
  pickFiles(): Promise<ImportSource[]>;
  /** 監聽從檔案總管拖進視窗的檔案；回傳取消監聽的函式 */
  onFilesDropped(handler: (sources: ImportSource[]) => void): () => void;
  /** 讀素材規格，建立素材庫的一筆（id 由呼叫端給）；不支援的檔案拋 UnsupportedMediaError */
  probe(source: ImportSource, id: string): Promise<Media>;
  /**
   * 匯入後的背景準備：縮圖、音量包絡，Windows 版另外產生 540p 代理檔（回傳 proxyPath，記進素材後 mediaUrl 就改用代理檔）。
   * onProgress 回報 0～1。重工作由呼叫端排隊，一次一支（§5.21）。
   */
  prepare(media: Media, onProgress: (ratio: number) => void): Promise<Prepared>;
  /** 素材不再使用（換專案）：釋放這個素材佔用的資源（網頁版的 blob 網址） */
  release(media: Media): void;
  /** 示範專案的素材資料夾：網頁版是開發伺服器的 samples/；Windows 版找 repo 的 samples/，找不到（安裝版）回 null */
  demoMediaRoot(): Promise<string | null>;
  /**
   * 範例專案（§5.22）：讀 sample/project.json，回傳範例資料夾（素材路徑改寫用，見 project/sample.ts）與檔案內容；找不到回 null。
   * 網頁版從靜態網站讀（root 是 "sample"）；Windows 版讀安裝資料夾裡的 sample\（開發時是 repo 的 public\sample\）。
   */
  openSample(): Promise<{ root: string; text: string } | null>;
  /** 匯出讀的素材來源（原檔或中間檔，不用代理檔）：網頁版是 File，Windows 版是 asset 協定的網址（mediabunny 分段讀） */
  exportSource(media: Media): Promise<Blob | string>;
  /** 選擇匯出位置（存檔對話框）；使用者取消回 null */
  openExportTarget(suggestedName: string): Promise<ExportTarget | null>;
  /** WebCodecs 解不了的原檔轉成原解析度中間檔，回傳中間檔位置（Q5） */
  makeMezzanine(mediaId: string): Promise<string>;
  /** 抽出素材 [start, end) 的 16 kHz 單聲道 16-bit WAV 給 Muse ASR（§5.2；長片由呼叫端在無聲處切段） */
  extractAsrAudio(media: Media, start: number, end: number): Promise<Uint8Array>;
  /**
   * 縮圖序列（D39）：產生影片素材第 tier 層的第 chunk 段（每段 60 秒，見 media/thumbs.ts），存進本機快取並留下完成標記。
   * 第 0 層在匯入時從原檔做（只解關鍵幀）；細層有代理檔就從代理檔做。
   */
  makeThumbs(media: Media, tier: number, chunk: number): Promise<void>;
  /** 快取裡各層做好的段（重開專案不重做） */
  thumbStatus(media: Media): Promise<DoneMap>;
  /** 一張縮圖的網址（桌面版是 asset 協定的檔案網址，網頁版是 blob: 網址）；沒有回 null */
  thumbUrl(media: Media, tier: number, index: number): Promise<string | null>;
  /** 專案資料夾是否可用（網頁版要 File System Access；不能用時退回瀏覽器裡的自動存檔） */
  readonly projectFolders: boolean;
  /** 新專案：選放在哪裡，建 <名稱>.wordblade\（含隱藏的 .data\）；取消回 null */
  createProject(name: string): Promise<ProjectLocation | null>;
  /** 開舊專案：選 .wordblade 資料夾（或裡面的 project.json）；取消回 null */
  openProject(): Promise<{ location: ProjectLocation; text: string } | null>;
  /** 重新開最近的專案（不用對話框）；找不到或沒有權限回 null */
  reopenProject(location: ProjectLocation): Promise<{ location: ProjectLocation; text: string } | null>;
  /** 寫專案 .data 裡的文字檔（rel 相對 .data，例如 masks/<id>.json；D41 P5） */
  writeData(location: ProjectLocation, rel: string, text: string): Promise<void>;
  /** 讀專案 .data 裡的文字檔；沒有回 null */
  readData(location: ProjectLocation, rel: string): Promise<string | null>;
  /** 目前開著的專案資料夾（產生的檔案寫進它的 .data\generated\）；null＝沒開 */
  setProjectLocation(location: ProjectLocation | null): void;
  /** 寫 project.json（暫存檔＋改名，不會寫壞） */
  writeProject(location: ProjectLocation, text: string): Promise<void>;
  /** 素材的內容指紋（大小＋頭尾各 1 MB）；拿不到回 undefined */
  mediaFingerprint(media: Media): Promise<string | undefined>;
  /** 找回素材：依序試候選路徑，第一個存在且指紋相同的回傳更新過路徑的素材；都不是回 null（介面請使用者重新連結） */
  locateMedia(media: Media, candidates: string[], fingerprint?: string): Promise<Media | null>;
  /**
   * 網頁版：讓使用者授權一個素材資料夾（素材在專案資料夾外面時；允許一次就記住，之後開專案自動在裡面找）。
   * 要在使用者手勢裡呼叫；取消或桌面版回 false。
   */
  grantMediaFolder(): Promise<boolean>;
  /** 網頁版重新連結：使用者選的檔案（source）接上找不到的素材，回傳素材的 handleKey；Windows 版走 locateMedia，回 null */
  adoptFile(media: Media, source: ImportSource): Promise<string | null>;
  /**
   * 錄音退路（spec §5.18）：Windows 版 getUserMedia 被擋時改用內建錄音機；網頁版沒有（null）。
   * stop 回傳錄好的檔案（.m4a，已搬進專案 .data\generated\ 或 app 資料夾），接著走一般匯入。
   */
  readonly recorderFallback: { start(): Promise<void>; stop(): Promise<ImportSource> } | null;
  /**
   * 人聲／背景音樂分離（§5.14，只有 Windows 版）：本機推論，結果是兩個 WAV（人聲、背景音樂），回傳成可走一般匯入（importSources）的來源。
   * 第一次用會先下載模型（stage="download"）；已分離過的素材（同內容指紋）直接回傳快取。onProgress 回報 0～1。
   * 取消用 cancelSeparation，這個呼叫會以 SeparationCancelled 拒絕。
   */
  separateVocals(media: Media, onProgress: (p: SeparationProgress) => void): Promise<SeparationResult>;
  /** 取消這支素材進行中的分離 */
  cancelSeparation(mediaId: string): Promise<void>;
  /**
   * 程式產生的檔案（AI 音效與配樂的 WAV，§5.15）變成可匯入的來源，接著走一般的匯入流程（useMediaLibrary.importSources）。
   * 開著專案資料夾時寫進 .data\generated\（D41 P5），沒開時：Windows 版寫進 app 資料夾的 generated/（回傳路徑），網頁版包成 File。
   * name 是建議的檔名（例如 sfx-whoosh.wav）；副檔名只認 wav、png、webp（材質圖是 PNG，§5.12），其他一律當 wav。
   */
  importGenerated(name: string, bytes: Uint8Array): Promise<ImportSource>;
}

/** 還沒實作的 Engine 功能；訊息帶方法名稱，方便看出是哪一個 */
export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`Engine.${method} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}
