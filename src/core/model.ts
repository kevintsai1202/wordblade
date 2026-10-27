// TS 核心的資料模型（spec §4）。只有資料，沒有 IO：素材長度、fps 等由 Engine 讀好後當普通資料傳進來。
// 時間一律用秒（number）；「素材時間」是素材自己的時間，「時間軸時間」是成片上的時間。

/** 秒 */
export type Seconds = number;

/** 素材庫的一筆（§4 Media） */
export interface Media {
  id: string;
  /** 顯示用的檔名 */
  name?: string;
  /** Windows 版的檔案路徑 */
  path?: string;
  /** 網頁版：指向 IndexedDB 裡 FileSystemHandle 的鍵 */
  handleKey?: string;
  kind: "video" | "image" | "audio";
  duration: Seconds;
  fps?: number;
  width?: number;
  height?: number;
  hasAlpha?: boolean;
  /** 有沒有聲音 */
  audio?: boolean;
  proxyPath?: string;
  mezzaninePath?: string;
}

/** 軌道（§4 Track）。V1 是主軌：片段首尾相接、漣漪剪輯 */
export interface Track {
  id: string;
  kind: "video" | "audio";
  /** 音軌的角色：配樂壓低看它（music 被 dialogue 壓） */
  role?: "dialogue" | "music" | "sfx";
  /** 同種軌道裡的順序；video 的 index 0 就是 V1 */
  index: number;
  muted: boolean;
  locked: boolean;
  volume: number;
}

/** 局部放大的關鍵幀（§5.19）；用素材時間記，片段被切開時跟著素材走 */
export interface ZoomKey {
  src: Seconds;
  scale: number;
  cx: number;
  cy: number;
}

/** 子母畫面的框（0～1，相對於畫面） */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 時間軸上的一段（§4 Clip） */
export interface Clip {
  id: string;
  mediaId: string;
  trackId: string;
  /** 素材時間的入點與出點 */
  srcIn: Seconds;
  srcOut: Seconds;
  /** 時間軸時間的起點 */
  start: Seconds;
  /** 變速倍率（§5.20）；1 是原速 */
  speed: number;
  opacity: number;
  /** 不設就是全畫面 */
  transform?: Rect;
  fadeIn: Seconds;
  fadeOut: Seconds;
  volume: number;
  zoomKeys?: ZoomKey[];
  /** 定格片段（§5.20）：整段一直顯示素材時間 at 那一格，長度 hold；這時 srcIn＝srcOut＝at、speed 不用 */
  freeze?: { at: Seconds; hold: Seconds };
}

/** 逐字稿的一個詞（素材時間） */
export interface Word {
  id: string;
  mediaId: string;
  text: string;
  start: Seconds;
  end: Seconds;
}

/** 使用者調過的字幕斷點（D26），以詞的 id 為鍵 */
export interface CaptionBreak {
  wordId: string;
  kind: "breakAfter" | "joinAfter" | "lineBreakAfter";
}

/** 遮罩物件（素材時間）；逐格資料在旁檔 masks/<id>.bin */
export interface MaskObject {
  id: string;
  mediaId: string;
  prompt: string;
  label: string;
  framesRef: string;
  effect: { kind: "mosaic" | "blur" | "solid"; strength: number };
  enabled: boolean;
}

/** 鏡頭關鍵幀；t 是相對於區段開頭的秒數 */
export interface CameraKey {
  t: Seconds;
  position: [number, number, number];
  target: [number, number, number];
  fov: number;
}

/** 特效區段（時間軸時間）：2D／3D 插件與 3D 場景 */
export interface Effect {
  id: string;
  kind: "anim2d" | "anim3d" | "scene3d";
  start: Seconds;
  end: Seconds;
  pluginId: string;
  params: Record<string, unknown>;
  cameraKeys?: CameraKey[];
  anchorIds: string[];
}

/** 定位點：綁素材時間（mediaId＋src）或時間軸時間（time） */
export interface Anchor {
  id: string;
  mediaId?: string;
  src?: Seconds;
  time?: Seconds;
  x: number;
  y: number;
  label: string;
  from: "user" | "sam" | "director";
}

/** AI 導演的建議（素材時間） */
export interface Suggestion {
  id: string;
  mediaId: string;
  kind: "cut" | "mask" | "effect" | "camera" | "fix" | "zoom";
  start: Seconds;
  end: Seconds;
  payload: Record<string, unknown>;
  reason: string;
  status: "pending" | "applied" | "skipped";
}

/**
 * 2D／3D 插件。2D 沿用原專案（字導字演）的元件格式：component 是正規化過的完整元件
 * （id、version、schema、category、preview、kind、name、description、tags、params、code），
 * hash＝componentHash(component)，由沙盒算（雜湊涵蓋整個元件，所以要存完整物件才算得回同一個值）。
 */
export interface Plugin {
  /** 內容雜湊（特效的圖層用它指到插件） */
  hash: string;
  kind: "2d" | "3d";
  source: "builtin" | "vibe";
  /** 完整元件（2D：原專案格式；3D：10/30 定） */
  component: Record<string, unknown>;
}

/** AI 音效與配樂（D27，宣告式） */
export interface Synth {
  id: string;
  kind: "sound" | "music";
  spec: Record<string, unknown>;
  source: "builtin" | "ai";
  renderedMediaId?: string;
}

/** 聲音分離的結果 */
export interface Stem {
  mediaId: string;
  vocalsId: string;
  backgroundId: string;
  model: string;
}

/** 整個專案（存成 .wordblade.json） */
export interface Project {
  media: Media[];
  tracks: Track[];
  clips: Clip[];
  words: Word[];
  captionBreaks: CaptionBreak[];
  masks: MaskObject[];
  effects: Effect[];
  anchors: Anchor[];
  suggestions: Suggestion[];
  plugins: Plugin[];
  synths: Synth[];
  stems: Stem[];
}
