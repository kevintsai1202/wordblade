// 一支素材的 Muse ASR 流程（spec §5.2）：在無聲處切段 → 抽音訊（Engine）→ 最多 3 段平行送閘道 → 時間換回素材時間 →
// 詞級時間：閘道有回 DELTA 事件就用它當錨點（deltasToWords），舊版閘道沒有就依音量包絡把 turn 的字攤開（turnsToWords）。抽音訊與送出由呼叫端注入（測試換成假的）。
import type { Envelope } from "../audio/envelope";
import type { Media, Word } from "../core/model";
import { splitAtSilence } from "./segment";
import { toTraditional } from "./traditional";
import { coverage, DELTA_DELAY, deltasToWords, turnsToWords, type Delta, type Turn } from "./wordTiming";

/** 閘道 /v1/asr 的回應 */
export interface AsrResponse {
  transcript: string;
  turns: { transcript: string; startMs: number; endMs: number; speaker: string | null }[];
  audioDurationMs: number;
  /** DELTA 串流的文字事件（閘道 10/27 起才有；舊版閘道沒有時退回依包絡推算） */
  deltas?: { text: string; ms: number }[];
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
  /** Muse 回的各段話（已換成素材時間；診斷與回歸測試用） */
  turns: Turn[];
}

/** 選項 */
export interface TranscribeOptions {
  /** 同時送幾段（spec：最多 3） */
  parallel?: number;
  /**
   * 每段最長幾秒（預設 60）：詞級時間的誤差主要跟 Muse 一個 turn 多長有關，段越長 turn 越長
   * （2026-10-27 實測：180 秒時一個 turn 85 秒、句首誤差 1.5～2.3 秒；60 秒平均 0.19 秒；30 秒切點太多反而 0.36 秒）
   */
  maxSegment?: number;
  /** 閘道忙時重試的等待基數（毫秒） */
  retryDelayMs?: number;
}

/** 比較用：小寫、去掉標點 */
const bare = (text: string) => text.toLowerCase().replace(/[\p{P}\p{S}]/gu, "");
/** 字尾的標點 */
const trailing = (text: string) => /[\p{P}\p{S}]+$/u.exec(text)?.[0] ?? "";

/**
 * 相鄰的同一個英文字併成一個：Muse ASR 偶爾把一個字重複輸出（2026-10-29 實測 DIARIZATION、ENDPOINTING、DELTA 都會，
 * 每 2 分鐘 3～7 處、每次不同字；講稿只有一處是真的重複），字幕會出現「file file」。
 * 留第一個字、時間延到第二個的結尾、字尾標點用第二個的。中日文的疊字（謝謝、看看）是真的詞，不動。
 * 真的口吃（with with）也會被併掉——字幕上本來就不該出現，對應的畫面與聲音不受影響。
 */
export function collapseRepeats(words: Word[]): Word[] {
  const out: Word[] = [];
  for (const w of words) {
    const prev = out[out.length - 1];
    const key = bare(w.text);
    if (prev && key && /[a-z0-9]/.test(key) && key === bare(prev.text)) {
      out[out.length - 1] = { ...prev, text: prev.text.replace(/[\p{P}\p{S}]+$/u, "") + trailing(w.text), end: Math.max(prev.end, w.end) };
    } else {
      out.push(w);
    }
  }
  return out;
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
  const max = options.maxSegment ?? 60;
  // 在上限前 1/3 的範圍內找無聲處（最多 30 秒）
  const segments = splitAtSilence(env, media.duration, max, Math.min(30, max / 3));
  const turns: Turn[][] = segments.map(() => []);
  /** 各段的 DELTA 事件（素材時間）；有任何一段沒有 deltas 就整支退回包絡推算 */
  const deltas: (Delta[] | null)[] = segments.map(() => null);
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
      // DELTA 版的 turn 時間是事件時間（比實際晚），扣掉延遲
      const shift = res.deltas ? DELTA_DELAY : 0;
      const list: Turn[] = res.turns
        .filter((t) => t.transcript.trim())
        .map((t) => ({ text: t.transcript, start: Math.max(seg.start, seg.start + t.startMs / 1000 - shift), end: Math.min(seg.end, seg.start + t.endMs / 1000 - shift) }));
      if (res.deltas) deltas[i] = res.deltas.map((d) => ({ text: d.text, t: seg.start + d.ms / 1000 }));
      // 沒有 turn 時間（只有整段文字）：整段當一個 turn
      if (!list.length && res.transcript.trim()) list.push({ text: res.transcript, start: seg.start, end: seg.end });
      turns[i] = list;
      onProgress({ done: ++done, total: segments.length });
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, segments.length) }, worker));

  const all = turns.flat().sort((a, b) => a.start - b.start);
  // 每段都有 DELTA 事件：用它當詞級時間的錨點；否則照舊依包絡把 turn 的字攤開
  const anchored = deltas.every((d) => d !== null);
  // 中文一律用繁體（Muse ASR 對台灣口音也回簡體）
  const words = await toTraditional(collapseRepeats(anchored ? deltasToWords(media.id, deltas.flatMap((d) => d!), env) : turnsToWords(media.id, all, env)));
  return { words, segments: segments.length, coverage: coverage(all, env, 0, media.duration), turns: all };
}
