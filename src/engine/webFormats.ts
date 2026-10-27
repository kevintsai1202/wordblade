// 網頁版的格式判斷（§5.21）：只吃瀏覽器（WebCodecs）解得了的格式，其他提示改用 Windows 版。純函式，方便測試。
import type { Media } from "../core/model";

const VIDEO_EXT = ["mp4", "m4v", "mov", "mkv", "webm", "avi"];
const IMAGE_EXT = ["png", "jpg", "jpeg", "webp", "gif", "bmp"];
const AUDIO_EXT = ["mp3", "wav", "m4a", "aac", "ogg", "opus", "flac"];

/** 依副檔名（其次 MIME）判斷是影片、圖片還是聲音；都不是回 null */
export function classifyFile(name: string, mime: string): Media["kind"] | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (VIDEO_EXT.includes(ext)) return "video";
  if (IMAGE_EXT.includes(ext)) return "image";
  if (AUDIO_EXT.includes(ext)) return "audio";
  const top = mime.split("/")[0];
  return top === "video" || top === "image" || top === "audio" ? top : null;
}

/** mediabunny 讀出的格式資訊（container 用小寫短名：mp4、mov、wave、mp3…） */
export interface WebFormatInfo {
  kind: Media["kind"];
  container: string | null;
  videoCodec: string | null;
  audioCodec: string | null;
}

/** 提示改用 Windows 版的訊息 */
const USE_DESKTOP = "This format isn't supported in the browser. Use the Windows app, or convert it to an H.264/AAC MP4.";

/** 網頁版能不能用這個素材：可以回 null，不行回給使用者看的訊息 */
export function webSupport(info: WebFormatInfo): string | null {
  if (info.kind === "image") return null;
  if (info.kind === "video") {
    if (info.container !== "mp4" && info.container !== "mov") return USE_DESKTOP;
    if (info.videoCodec !== "avc") return USE_DESKTOP;
    if (info.audioCodec !== null && info.audioCodec !== "aac") return USE_DESKTOP;
    return null;
  }
  const ok = (info.container === "wave" && info.audioCodec?.startsWith("pcm")) || info.audioCodec === "mp3" || info.audioCodec === "aac";
  return ok ? null : USE_DESKTOP;
}
