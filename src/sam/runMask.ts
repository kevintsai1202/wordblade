// 對一支素材的一段跑 SAM 遮罩（Mask 頁籤與 AI 導演的「遮隱私」共用）：轉小檔（桌面有代理檔也用原檔：SAM 要看清楚小東西）→ 閘道 → 遮罩物件。
// 呼叫端負責同意說明、重工作登記與寫進專案。
import { loadSettings } from "../ai/gateway";
import type { MaskObject, Media } from "../core/model";
import { grabJpegs } from "./frames";
import { runLocate } from "./locate";
import type { Engine } from "../engine/Engine";
import { SamApi } from "./api";
import { makeSamClip } from "./clip";
import { runSam, type SamProgress, type SamRunResult } from "./run";

/** 跑一次：phrase 是英文名詞片語（已翻譯過）；start／end 是素材時間 */
export async function runMaskJob(opts: {
  engine: Engine;
  media: Media;
  phrase: string;
  start: number;
  end: number;
  fps: number;
  signal?: AbortSignal;
  onProgress?: (p: SamProgress) => void;
}): Promise<SamRunResult> {
  const { engine, media } = opts;
  const api = new SamApi(loadSettings());
  const src = await engine.exportSource(media);
  return runSam({
    mediaId: media.id, prompt: opts.phrase, start: opts.start, end: opts.end, fps: opts.fps,
    makeClip: (s, e) => makeSamClip(src, s, e, { fps: opts.fps, maxWidth: 1280, videoW: media.width ?? 1280, videoH: media.height ?? 720, signal: opts.signal }),
    api, signal: opts.signal, onProgress: opts.onProgress,
  });
}

/**
 * 螢幕文字類個資（帳號、密碼、金鑰、Email…）的遮罩：SAM 分割不出文字，改由 Muse Spark 在每秒 1 格的畫面上找框（runLocate）。
 * label 是清單上的名稱（例如 API key）。
 */
export async function runTextMaskJob(opts: {
  engine: Engine;
  media: Media;
  phrase: string;
  start: number;
  end: number;
  signal?: AbortSignal;
  onProgress?: (p: { done: number; total: number }) => void;
}): Promise<{ objects: MaskObject[]; frames: number }> {
  const api = new SamApi(loadSettings());
  const src = await opts.engine.exportSource(opts.media);
  return runLocate({
    mediaId: opts.media.id, target: opts.phrase, label: opts.phrase, start: opts.start, end: opts.end,
    grab: (times) => grabJpegs(src, times), api: { locate: (t, frames) => api.locate(t, frames, opts.signal) },
    signal: opts.signal, onProgress: opts.onProgress,
  });
}

