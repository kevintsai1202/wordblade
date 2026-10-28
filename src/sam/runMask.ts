// 對一支素材的一段跑 SAM 遮罩（Mask 頁籤與 AI 導演的「遮隱私」共用）：轉小檔（桌面有代理檔也用原檔：SAM 要看清楚小東西）→ 閘道 → 遮罩物件。
// 呼叫端負責同意說明、重工作登記與寫進專案。
import { loadSettings } from "../ai/gateway";
import type { Media } from "../core/model";
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
