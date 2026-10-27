// 平台相關功能的介面（spec §3、D21）。
// 介面、TS 核心、合成器、沙盒只寫一份；讀寫檔、代理檔、中間檔、抽 ASR 音訊、聲音分離、錄音
// 這些跟平台有關的事收在 Engine 後面，由 DesktopEngine（Tauri＋Rust）與 WebEngine（瀏覽器 API）各自實作。

import type { Envelope } from "../audio/envelope";
import type { Media } from "../core/model";

/** 要匯入的檔案：Windows 版是路徑，網頁版是 File */
export type ImportSource = { kind: "path"; path: string; name: string } | { kind: "file"; file: File; name: string };

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

/** 這個平台能做的事；介面依此決定要不要顯示功能或提示改用 Windows 版 */
export interface EngineCapabilities {
  /** 聲音分離（D28：只有 Windows 版） */
  vocalSeparation: boolean;
  /** 任何 ffmpeg 讀得到的格式都能匯入；false 時只吃 H.264／AAC 的 MP4、MOV（§5.21） */
  anyFormatImport: boolean;
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
  /** WebCodecs 解不了的原檔轉成原解析度中間檔，回傳中間檔位置（Q5） */
  makeMezzanine(mediaId: string): Promise<string>;
  /** 抽出 16 kHz 單聲道 WAV 給 Muse ASR（§5.2） */
  extractAsrAudio(mediaId: string): Promise<Blob>;
  /** 人聲／背景音樂分離，回傳兩個衍生素材的 id（§5.14） */
  separateVocals(mediaId: string): Promise<{ vocalsId: string; backgroundId: string }>;
}

/** 還沒實作的 Engine 功能；訊息帶方法名稱，方便看出是哪一個 */
export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`Engine.${method} is not implemented yet`);
    this.name = "NotImplementedError";
  }
}
