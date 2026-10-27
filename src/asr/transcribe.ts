// 一支素材的 Muse ASR 流程（spec §5.2）：在無聲處切段 → 抽音訊（Engine）→ 最多 3 段平行送閘道 → turn 時間換回素材時間 →
// 依音量包絡重建詞級時間。抽音訊與送出由呼叫端注入（測試換成假的）。
import type { Envelope } from "../audio/envelope";
import type { Media, Word } from "../core/model";
import { splitAtSilence } from "./segment";
import { coverage, turnsToWords, type Turn } from "./wordTiming";

/** 閘道 /v1/asr 的回應 */
export interface AsrResponse {
  transcript: string;
  turns: { transcript: string; startMs: number; endMs: number; speaker: string | null }[];
  audioDurationMs: number;
}

/** 進度：完成幾段／共幾段 */
export interface TranscribeProgress {
  done: number;
  total: number;
}

/** 轉錄結果 */
export interface TranscribeResult {
  words: Word[];
  /** 送了幾段 */
  segments: number;
  /** turns 涵蓋了多少比例的有聲時間（低於 0.9 要提醒使用者可能漏段） */
  coverage: number;
}

/** 選項 */
export interface TranscribeOptions {
  /** 同時送幾段（spec：最多 3） */
  parallel?: number;
  /** 每段最長幾秒 */
  maxSegment?: number;
  /** 閘道忙時重試的等待基數（毫秒） */
  retryDelayMs?: number;
}

/** 閘道忙（503）最多試幾次 */
const ATTEMPTS = 3;

/** 轉錄一支素材 */
export async function transcribeMedia(
  media: Media,
  env: Envelope,
  extract: (media: Media, start: number, end: number) => Promise<Uint8Array>,
  send: (wav: Uint8Array) => Promise<AsrResponse>,
  onProgress: (p: TranscribeProgress) => void,
  options: TranscribeOptions = {},
): Promise<TranscribeResult> {
  const parallel = options.parallel ?? 3;
  const segments = splitAtSilence(env, media.duration, options.maxSegment ?? 180);
  const turns: Turn[][] = segments.map(() => []);
  let next = 0;
  let done = 0;
  onProgress({ done, total: segments.length });

  /** 送一段；閘道忙就等一下再試 */
  const sendWithRetry = async (wav: Uint8Array): Promise<AsrResponse> => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await send(wav);
      } catch (e) {
        if ((e as { status?: number }).status !== 503 || attempt >= ATTEMPTS) throw e;
        await new Promise((r) => setTimeout(r, (options.retryDelayMs ?? 2000) * 2 ** (attempt - 1)));
      }
    }
  };

  /** 一個工作者：輪流拿下一段 */
  const worker = async () => {
    while (next < segments.length) {
      const i = next++;
      const seg = segments[i];
      const res = await sendWithRetry(await extract(media, seg.start, seg.end));
      const list: Turn[] = res.turns
        .filter((t) => t.transcript.trim())
        .map((t) => ({ text: t.transcript, start: seg.start + t.startMs / 1000, end: Math.min(seg.end, seg.start + t.endMs / 1000) }));
      // 沒有 turn 時間（只有整段文字）：整段當一個 turn
      if (!list.length && res.transcript.trim()) list.push({ text: res.transcript, start: seg.start, end: seg.end });
      turns[i] = list;
      onProgress({ done: ++done, total: segments.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, segments.length) }, worker));

  const all = turns.flat().sort((a, b) => a.start - b.start);
  return { words: turnsToWords(media.id, all, env), segments: segments.length, coverage: coverage(all, env, 0, media.duration) };
}
