// 詞級時間重建（spec §5.2 步驟 3）：Muse ASR 的 DIARIZATION 只有 turn 級起訖，這裡用音量包絡補出每個詞的時間。
// 1. 包絡找出有聲段（門檻依整支素材的音量分布，短於 0.25 秒的停頓合併）；
// 2. turn 的文字切成詞（英文以空白分、標點黏前一個詞；中日文逐字）；
// 3. 每個有聲段分到一串連續的詞（動態規劃，讓各段長度與詞數推估的長度最吻合），段內依字數比例分配；
//    停頓不分給任何詞，所以詞的頭尾自然落在實際開口與收尾。
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
