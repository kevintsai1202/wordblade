// 詞級時間重建（spec §5.2 步驟 3）：Muse ASR 的 DIARIZATION 只有 turn 級起訖，這裡用音量包絡補出每個詞的時間。
// 1. 包絡找出有聲段（門檻依整支素材的音量分布，短於 0.25 秒的停頓合併）；
// 2. turn 的文字切成詞（英文以空白分、標點黏前一個詞；中日文逐字）；
// 3. 每個有聲段分到一串連續的詞（動態規劃，讓各段長度與詞數推估的長度最吻合），段內依字數比例分配；
//    停頓不分給任何詞，所以詞的頭尾自然落在實際開口與收尾。
import type { Envelope } from "../audio/envelope";
import type { Seconds, Word } from "../core/model";
import { CJK, tokenize } from "../core/text";

/** 一段話（素材時間） */
export interface Turn {
  text: string;
  start: Seconds;
  end: Seconds;
}

/** 有聲段 */
export interface Voiced {
  start: Seconds;
  end: Seconds;
}

/** 短於這個長度的停頓視為同一段（秒） */
const MIN_SILENCE: Seconds = 0.25;
/** 短於這個長度的有聲段捨去（雜音） */
const MIN_VOICED: Seconds = 0.1;

// 分詞放在 core/text.ts（改字即剪也要用），這裡沿用並轉出
export { tokenize };

/** 有聲的門檻：依整支素材的音量分布（底噪 10 百分位與音量 95 百分位之間的 15%），至少 0.005 */
export function levelThreshold(env: Envelope): number {
  if (!env.rms.length) return 0.005;
  const sorted = Float32Array.from(env.rms).sort();
  const floor = sorted[Math.floor(sorted.length * 0.1)];
  const peak = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return Math.max(0.005, floor + 0.15 * (peak - floor));
}

/** [a, b) 內的有聲段 */
export function voicedSegments(env: Envelope, a: Seconds, b: Seconds, threshold: number = levelThreshold(env)): Voiced[] {
  const raw: Voiced[] = [];
  const from = Math.max(0, Math.floor(a * env.rate));
  const to = Math.min(env.rms.length, Math.ceil(b * env.rate));
  let open = -1;
  for (let i = from; i <= to; i++) {
    const on = i < to && env.rms[i] >= threshold;
    if (on && open < 0) open = i;
    if (!on && open >= 0) {
      raw.push({ start: Math.max(a, open / env.rate), end: Math.min(b, i / env.rate) });
      open = -1;
    }
  }
  // 合併短停頓，再丟掉太短的段
  const merged: Voiced[] = [];
  for (const v of raw) {
    const last = merged[merged.length - 1];
    if (last && v.start - last.end < MIN_SILENCE) last.end = v.end;
    else merged.push({ ...v });
  }
  return merged.filter((v) => v.end - v.start >= MIN_VOICED);
}

/** 詞的權重：去掉標點後的字數（至少 1），英文加 1 當作字間空白 */
function weight(word: string): number {
  const bare = word.replace(/[\p{P}\p{S}]/gu, "");
  return Math.max(1, bare.length + (CJK.test(bare) ? 0 : 1));
}

/**
 * 決定每個有聲段分到哪些詞（動態規劃）：每段分到一串連續的詞（可以是 0 個，例如換氣、雜音），
 * 讓「段的實際長度」與「這些詞依平均語速該有的長度」的差距平方和（÷ 段長）最小。
 * 回傳 bounds：第 i 段分到詞 [bounds[i], bounds[i+1])。
 * 原本「整個 turn 依字數比例攤、停頓吸附到最近的詞界」在長 turn（Muse 實測一個 turn 85 秒、幾乎沒有標點）會一路累積誤差，
 * 句首提早 1～2.7 秒；改成整體最佳化後各段各自對齊。
 */
function assign(weights: number[], lengths: number[]): number[] {
  const n = weights.length;
  const m = lengths.length;
  const prefix = [0];
  for (const w of weights) prefix.push(prefix[prefix.length - 1] + w);
  /** 語速：每秒幾個權重單位 */
  const rate = prefix[n] / lengths.reduce((a, b) => a + b, 0);
  /** 第 i 段放詞 [k, j) 的代價 */
  const cost = (i: number, k: number, j: number) => {
    const diff = lengths[i] - (prefix[j] - prefix[k]) / rate;
    return (diff * diff) / Math.max(lengths[i], 0.05);
  };
  // best[i][j]：前 i 段放了前 j 個詞的最小代價；from[i][j]：第 i 段從哪個詞開始
  const best = Array.from({ length: m + 1 }, () => new Float64Array(n + 1).fill(Infinity));
  const from = Array.from({ length: m + 1 }, () => new Int32Array(n + 1));
  best[0][0] = 0;
  for (let i = 1; i <= m; i++) {
    for (let j = 0; j <= n; j++) {
      for (let k = 0; k <= j; k++) {
        if (best[i - 1][k] === Infinity) continue;
        const c = best[i - 1][k] + cost(i - 1, k, j);
        if (c < best[i][j]) {
          best[i][j] = c;
          from[i][j] = k;
        }
      }
    }
  }
  const bounds = new Array<number>(m + 1);
  bounds[m] = n;
  for (let i = m; i > 0; i--) bounds[i - 1] = from[i][bounds[i]];
  return bounds;
}

/** 把詞放到有聲段上：先用 assign 決定每段分到哪些詞，段內再依字數比例分配；回傳每個詞的起訖 */
function place(tokens: string[], segs: Voiced[]): Voiced[] {
  const weights = tokens.map(weight);
  const lengths = segs.map((s) => s.end - s.start);
  const bounds = segs.length > 1 ? assign(weights, lengths) : [0, tokens.length];
  const out: Voiced[] = new Array(tokens.length);
  for (let i = 0; i < segs.length; i++) {
    const [k, j] = [bounds[i], bounds[i + 1]];
    const total = weights.slice(k, j).reduce((a, b) => a + b, 0);
    let acc = 0;
    for (let w = k; w < j; w++) {
      const start = segs[i].start + (lengths[i] * acc) / total;
      acc += weights[w];
      out[w] = { start, end: segs[i].start + (lengths[i] * acc) / total };
    }
  }
  return out;
}

/** 秒數取到毫秒 */
const ms = (t: Seconds) => Math.round(t * 1000) / 1000;

/** 各段話 → 這支素材的詞（素材時間，依序；id 是「素材 id:w序號」） */
export function turnsToWords(mediaId: string, turns: Turn[], env: Envelope): Word[] {
  const threshold = levelThreshold(env);
  const words: Word[] = [];
  for (const turn of turns) {
    const tokens = tokenize(turn.text);
    if (!tokens.length || turn.end <= turn.start) continue;
    const voiced = voicedSegments(env, turn.start, turn.end, threshold);
    const segs = voiced.length ? voiced : [{ start: turn.start, end: turn.end }];
    place(tokens, segs).forEach((span, i) => {
      words.push({ id: `${mediaId}:w${words.length}`, mediaId, text: tokens[i], start: ms(span.start), end: ms(span.end) });
    });
  }
  return words;
}

/** turns 涵蓋了 [a, b) 內多少比例的有聲時間（Muse 偶爾漏段，原專案 128 秒的片只涵蓋 41.9 秒）；沒有有聲段回 1 */
export function coverage(turns: Turn[], env: Envelope, a: Seconds, b: Seconds): number {
  const voiced = voicedSegments(env, a, b);
  const total = voiced.reduce((s, v) => s + (v.end - v.start), 0);
  if (total <= 0) return 1;
  let covered = 0;
  for (const v of voiced) {
    for (const t of turns) covered += Math.max(0, Math.min(v.end, t.end) - Math.max(v.start, t.start));
  }
  return Math.min(1, covered / total);
}

/** Muse DELTA 串流的一個文字事件（素材時間：t＝事件當時處理到的秒數） */
export interface Delta {
  text: string;
  t: Seconds;
}

/** DELTA 事件比字的結尾晚多少（秒；2026-10-27 實測句首 0.36～1.09、扣掉字長約 0.3～0.4） */
export const DELTA_DELAY: Seconds = 0.35;
/** 估出來的起點落在無聲處時，往後找開口最多找多遠 */
const SNAP_FORWARD: Seconds = 1.5;
/** 由 DELTA 事件估字的範圍時，每個字最多佔幾秒 */
const MAX_WORD: Seconds = 0.5;
/** 估出來的起點離開口多近就吸附過去（前一個字在停頓之前時） */
const SNAP_NEAR: Seconds = 0.3;

/**
 * DELTA 錨點 → 詞級時間（spec §5.2 步驟 3）：
 * 1. 每個事件的字佔 [前一個事件時間 − 延遲, 這個事件時間 − 延遲]（每個字最多 0.5 秒），同一事件的幾個字依字數比例分；
 * 2. 起點落在無聲處 → 往後吸附到下一個開口（1.5 秒內；字不會在停頓裡）；離開口 0.3 秒內、且前一個字在停頓之前 → 吸附到開口；
 * 3. 起點嚴格遞增；結尾是下一個字的起點，若中間有停頓就收在有聲段的結尾。
 * Muse 沒有詞級時間，但 DELTA 事件約每 0.32 秒一個、每個約 1.2 字，比依字數攤在整段話上準得多（長 turn 不再累積誤差）。
 */
export function deltasToWords(mediaId: string, deltas: Delta[], env: Envelope, delay: Seconds = DELTA_DELAY): Word[] {
  const voiced = voicedSegments(env, 0, env.rms.length / env.rate);
  /** t 所在的有聲段（不在就 -1） */
  const segAt = (t: Seconds) => voiced.findIndex((v) => t >= v.start && t < v.end);
  /** t 之後第一個開口 */
  const nextOnset = (t: Seconds) => voiced.find((v) => v.start >= t);
  // 1. 依事件估起點
  const est: { text: string; start: Seconds }[] = [];
  let prev: Seconds | null = null;
  for (const d of deltas) {
    const tokens = tokenize(d.text);
    if (!tokens.length) continue;
    const end = d.t - delay;
    // 每個字最多佔 0.5 秒：兩個事件之間隔著停頓時，不讓停頓被算成這個字的長度（否則停頓後的第一個字會落回前一句的尾巴）
    const begin = Math.min(end, Math.max(prev === null ? -Infinity : prev - delay, end - MAX_WORD * tokens.length));
    const weights = tokens.map(weight);
    const total = weights.reduce((a, b) => a + b, 0);
    let acc = 0;
    for (const [i, tok] of tokens.entries()) {
      est.push({ text: tok, start: begin + ((end - begin) * acc) / total });
      acc += weights[i];
    }
    prev = d.t;
  }
  // 2. 吸附到有聲段
  const starts: Seconds[] = [];
  for (const [i, w] of est.entries()) {
    let s = Math.max(0, w.start);
    const before = i ? starts[i - 1] : -Infinity;
    if (segAt(s) < 0) {
      // 落在無聲處：往後找開口
      const on = nextOnset(s);
      if (on && on.start - s <= SNAP_FORWARD) s = on.start;
    } else {
      // 在有聲段裡：附近有開口、而且前一個字在這個開口之前的停頓裡或更早 → 吸附到開口
      const near = voiced.find((v) => Math.abs(v.start - s) <= SNAP_NEAR && before < v.start);
      if (near) s = near.start;
    }
    starts.push(Math.max(s, before + 0.02));
  }
  // 3. 結尾
  return est.map((w, i) => {
    const start = starts[i];
    const seg = voiced[segAt(start)];
    const next = i + 1 < starts.length ? starts[i + 1] : Infinity;
    const end = Math.min(next, seg ? seg.end : start + 0.5);
    // 長度限制在 0.05～1.5 秒；先捨入到毫秒再限制，避免捨入後短於 0.05
    const s0 = ms(start);
    return { id: `${mediaId}:w${i}`, mediaId, text: w.text, start: s0, end: Math.min(Math.max(ms(end), s0 + 0.051), s0 + 1.5) };
  });
}
