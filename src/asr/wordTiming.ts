// 詞級時間重建（spec §5.2 步驟 3）：Muse ASR 的 DIARIZATION 只有 turn 級起訖，這裡用音量包絡補出每個詞的時間。
// 1. 包絡找出有聲段（門檻依整支素材的音量分布，短於 0.25 秒的停頓合併）；
// 2. turn 的文字切成詞（英文以空白分、標點黏前一個詞；中日文逐字）；
// 3. 詞依字數比例分配在有聲段上（停頓不分給任何詞），跨過停頓的詞界吸附到停頓兩側，頭尾吸附到實際開口與收尾。
import type { Envelope } from "../audio/envelope";
import type { Seconds, Word } from "../core/model";

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

/** 中日韓文字（逐字成詞） */
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
/** 標點（黏到前一個詞） */
const PUNCT = /^[\p{P}\p{S}]+$/u;

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

/** 文字切成詞：英文以空白分，標點黏前一個詞（開頭的標點黏後一個）；中日韓逐字 */
export function tokenize(text: string): string[] {
  // 先拆出單字：中日韓字元各自一個，其他連續的非空白字元一個
  const pieces = text.match(new RegExp(`${CJK.source}|[^\\s${CJK.source.slice(1, -1)}]+`, "gu")) ?? [];
  const out: string[] = [];
  let lead = "";
  for (const p of pieces) {
    if (PUNCT.test(p)) {
      if (out.length) out[out.length - 1] += p;
      else lead += p;
      continue;
    }
    out.push(lead + p);
    lead = "";
  }
  if (lead && out.length) out[out.length - 1] += lead;
  return out;
}

/** 詞的權重：去掉標點後的字數（至少 1），英文加 1 當作字間空白 */
function weight(word: string): number {
  const bare = word.replace(/[\p{P}\p{S}]/gu, "");
  return Math.max(1, bare.length + (CJK.test(bare) ? 0 : 1));
}

/** 把 n 個詞依權重放到有聲段上，回傳每個詞的起訖 */
function place(tokens: string[], segs: Voiced[]): Voiced[] {
  const n = tokens.length;
  const weights = tokens.map(weight);
  const total = weights.reduce((a, b) => a + b, 0);
  /** cum[j]：第 j 個詞界的位置（0～1） */
  const cum = [0];
  for (const w of weights) cum.push(cum[cum.length - 1] + w / total);
  const lengths = segs.map((s) => s.end - s.start);
  const L = lengths.reduce((a, b) => a + b, 0);
  // 停頓 k（第 k 段與第 k+1 段之間）的位置；吸附到最接近、還沒用過的詞界
  const snapped = new Map<number, number>();
  let acc = 0;
  let lastJ = 0;
  for (let k = 0; k < segs.length - 1; k++) {
    acc += lengths[k] / L;
    let bestJ = -1;
    for (let j = lastJ + 1; j < n; j++) if (bestJ < 0 || Math.abs(cum[j] - acc) < Math.abs(cum[bestJ] - acc)) bestJ = j;
    if (bestJ < 0) break;
    snapped.set(bestJ, k);
    lastJ = bestJ;
  }
  /** 位置 f（0～1）在有聲段上的時間 */
  const at = (f: number): Seconds => {
    let x = f * L;
    for (let k = 0; k < segs.length; k++) {
      if (x <= lengths[k] || k === segs.length - 1) return segs[k].start + Math.min(x, lengths[k]);
      x -= lengths[k];
    }
    return segs[segs.length - 1].end;
  };
  /** 詞界 j 的時間（side：這個詞界是某個詞的結尾或下一個詞的開頭） */
  const boundary = (j: number, side: "start" | "end"): Seconds => {
    if (j === 0) return segs[0].start;
    if (j === n) return segs[segs.length - 1].end;
    const k = snapped.get(j);
    if (k !== undefined) return side === "end" ? segs[k].end : segs[k + 1].start;
    return at(cum[j]);
  };
  return tokens.map((_, i) => ({ start: boundary(i, "start"), end: boundary(i + 1, "end") }));
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
