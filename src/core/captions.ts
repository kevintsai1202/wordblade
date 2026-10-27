// 字幕（spec §5.2 第 5 步、D26）：字幕不另存文字，是「V1 上片段用到的詞＋斷句規則＋CaptionBreak」算出來的。
// 規則以英文為主：句末標點或停頓 ≥ 0.5 秒斷句；每行最多 42 字元、每段最多 2 行；
// 優先斷在逗號／分號／冒號之後，其次是連接詞與介系詞之前；冠詞、介系詞不留在行尾；不拆開數字與單位；
// 每段最短 1 秒、最長 7 秒；閱讀速度上限每秒 17 字元（超過就延長顯示，不蓋到下一段）。
import type { Project, Seconds } from "./model";
import { roundTime } from "./time";
import { sourceToTimeline } from "./timeline";

/** 每行最多字元數 */
export const MAX_LINE_CHARS = 42;
/** 每段最多行數 */
const MAX_LINES = 2;
/** 斷句的停頓門檻（秒） */
const SENTENCE_PAUSE: Seconds = 0.5;
/** 每段字幕的最短與最長顯示時間（秒） */
const MIN_CAPTION: Seconds = 1;
const MAX_CAPTION: Seconds = 7;
/** 閱讀速度上限（字元／秒） */
const MAX_CPS = 17;

/** 斷行時偏好斷在它之前的連接詞 */
const CONJUNCTIONS = new Set(["and", "but", "so", "or", "because", "if", "when", "while", "although", "though", "unless", "until", "since", "then", "which", "that"]);
/** 介系詞：偏好斷在它之前，不留在行尾 */
const PREPOSITIONS = new Set(["in", "on", "at", "to", "for", "with", "of", "from", "by", "about", "into", "onto", "over", "under", "after", "before", "between", "through", "during", "without"]);
/** 冠詞：不留在行尾 */
const ARTICLES = new Set(["a", "an", "the"]);
/** 單位：不和前面的數字拆開 */
const UNITS = new Set(["mb", "gb", "kb", "tb", "%", "s", "ms", "px", "fps", "hz", "khz", "mhz", "ghz", "km", "kg", "cm", "mm", "m", "min", "sec", "seconds", "minutes", "hours", "x"]);

/** 換算到時間軸的詞 */
export interface TimelineWord {
  id: string;
  text: string;
  start: Seconds;
  end: Seconds;
}

/** 一段字幕 */
export interface Caption {
  /** 以第一個詞的 id 當這段字幕的 id */
  id: string;
  start: Seconds;
  end: Seconds;
  lines: string[];
  wordIds: string[];
}

/** 去掉標點、轉小寫，用來比對詞表 */
function bare(word: string): string {
  return word.toLowerCase().replace(/^[^\p{L}\p{N}%]+|[^\p{L}\p{N}%]+$/gu, "");
}

/** V1 上片段用到的詞，換算到時間軸時間，依起點排序（起點落在片段素材範圍內的詞才算） */
export function timelineWords(project: Project): TimelineWord[] {
  const v1 = project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  const out: TimelineWord[] = [];
  for (const clip of project.clips) {
    if (clip.trackId !== v1 || clip.freeze) continue;
    for (const w of project.words) {
      if (w.mediaId !== clip.mediaId || w.start < clip.srcIn || w.start >= clip.srcOut) continue;
      out.push({
        id: w.id,
        text: w.text,
        start: sourceToTimeline(clip, w.start)!,
        end: sourceToTimeline(clip, Math.min(w.end, clip.srcOut))!,
      });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 在第 k 個詞之前斷行的分數：越高越適合 */
function breakScore(words: string[], k: number, lineLength: number, restFits: boolean, maxChars: number): number {
  const prev = words[k - 1];
  const next = bare(words[k]);
  const prevBare = bare(prev);
  let score = (lineLength / maxChars) * 1.5;
  if (/[,;:]$/.test(prev)) score += 3;
  if (CONJUNCTIONS.has(next)) score += 2;
  else if (PREPOSITIONS.has(next)) score += 1;
  if (ARTICLES.has(prevBare) || PREPOSITIONS.has(prevBare)) score -= 5;
  if (CONJUNCTIONS.has(prevBare)) score -= 2;
  if (/^\d+([.,]\d+)?$/.test(prevBare) && UNITS.has(next)) score -= 10;
  if (restFits) score += 1;
  return score;
}

/** 把一串詞斷成每行不超過 maxChars 的幾行（單一個詞比 maxChars 長時自成一行） */
export function breakLines(words: string[], maxChars: number = MAX_LINE_CHARS): string[][] {
  const lines: string[][] = [];
  let rest = words;
  while (rest.length > 0) {
    if (rest.join(" ").length <= maxChars) {
      lines.push(rest);
      break;
    }
    // 先求總行數最少（這一行＋剩下的字至少要幾行），只在行數最少的斷點裡比分數
    const candidates: { k: number; lines: number; score: number }[] = [];
    for (let k = 1; k < rest.length; k++) {
      const len = rest.slice(0, k).join(" ").length;
      if (len > maxChars) break;
      const restLen = rest.slice(k).join(" ").length;
      candidates.push({ k, lines: 1 + Math.ceil(restLen / maxChars), score: breakScore(rest, k, len, restLen <= maxChars, maxChars) });
    }
    const fewest = Math.min(...candidates.map((c) => c.lines));
    let best = 1;
    let bestScore = -Infinity;
    for (const c of candidates) {
      if (c.lines === fewest && c.score >= bestScore) {
        bestScore = c.score;
        best = c.k;
      }
    }
    lines.push(rest.slice(0, best));
    rest = rest.slice(best);
  }
  return lines;
}

/** 把詞分成句子：句末標點、停頓 ≥ 0.5 秒或 breakAfter 處斷開；joinAfter 取消斷點 */
function sentences(words: TimelineWord[], overrides: Map<string, string>): TimelineWord[][] {
  const out: TimelineWord[][] = [];
  let current: TimelineWord[] = [];
  words.forEach((w, i) => {
    current.push(w);
    const next = words[i + 1];
    const kind = overrides.get(w.id);
    const natural = !next || /[.?!]["')\]]*$/.test(w.text) || next.start - w.end >= SENTENCE_PAUSE;
    if (kind === "breakAfter" || (kind !== "joinAfter" && natural)) {
      out.push(current);
      current = [];
    }
  });
  if (current.length) out.push(current);
  return out;
}

/** 一句斷成行（lineBreakAfter 處強制換行） */
function sentenceLines(words: TimelineWord[], overrides: Map<string, string>): TimelineWord[][] {
  const segments: TimelineWord[][] = [[]];
  for (const w of words) {
    segments[segments.length - 1].push(w);
    if (overrides.get(w.id) === "lineBreakAfter") segments.push([]);
  }
  const lines: TimelineWord[][] = [];
  for (const seg of segments.filter((s) => s.length)) {
    let i = 0;
    for (const line of breakLines(seg.map((w) => w.text))) {
      lines.push(seg.slice(i, i + line.length));
      i += line.length;
    }
  }
  return lines;
}

/** 一句拆成數段字幕：每段最多 2 行、最長 7 秒（單行超過 7 秒時依時間再拆） */
function sentenceCaptions(words: TimelineWord[], overrides: Map<string, string>): TimelineWord[][] {
  const lines = sentenceLines(words, overrides).flatMap((line) => {
    // 單行就超過 7 秒：依時間切成數行
    const parts: TimelineWord[][] = [];
    let part: TimelineWord[] = [];
    for (const w of line) {
      if (part.length && w.end - part[0].start > MAX_CAPTION) {
        parts.push(part);
        part = [];
      }
      part.push(w);
    }
    if (part.length) parts.push(part);
    return parts;
  });
  const captions: TimelineWord[][][] = [];
  for (const line of lines) {
    const last = captions[captions.length - 1];
    const fits = last && last.length < MAX_LINES && line[line.length - 1].end - last[0][0].start <= MAX_CAPTION;
    if (fits) last.push(line);
    else captions.push([line]);
  }
  return captions.map((cap) => cap.flat()).filter((cap) => cap.length > 0);
}

/** 依專案算出全部字幕（時間軸時間） */
export function buildCaptions(project: Project): Caption[] {
  const overrides = new Map(project.captionBreaks.map((b) => [b.wordId, b.kind]));
  const words = timelineWords(project);
  const groups = sentences(words, overrides).flatMap((s) => sentenceCaptions(s, overrides));
  const captions: Caption[] = groups.map((g) => ({
    id: g[0].id,
    start: g[0].start,
    end: g[g.length - 1].end,
    lines: sentenceLines(g, overrides).map((line) => line.map((w) => w.text).join(" ")),
    wordIds: g.map((w) => w.id),
  }));
  // 顯示時間：至少 1 秒、閱讀速度不超過每秒 17 字元，但不超過 7 秒、不蓋到下一段
  captions.forEach((c, i) => {
    const chars = c.lines.join(" ").length;
    // 閱讀需要的時間無條件進位到微秒，量化後才不會差一點點超過上限
    const readEnd = c.start + Math.ceil((chars / MAX_CPS) * 1e6) / 1e6;
    const wanted = Math.max(c.end, c.start + MIN_CAPTION, readEnd);
    const limit = Math.min(c.start + MAX_CAPTION, captions[i + 1]?.start ?? Infinity);
    c.end = roundTime(Math.max(c.end, Math.min(wanted, limit)));
    c.start = roundTime(c.start);
  });
  return captions;
}
