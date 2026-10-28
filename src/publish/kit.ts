// 發佈包（spec §5.17、P1-7）的純函式：成片逐字稿分行（送給 Muse Spark）、語言判斷、章節整理、YouTube 說明文字與 publish.md。
// 章節的時間由模型給，可能是編的：先對齊到最近的「送出去的行首」，再套 YouTube 的章節規則。
import type { TimelineWord } from "../core/captions";

/** 成片逐字稿的一行（成片時間） */
export interface TranscriptLine {
  t: number;
  text: string;
}

/** 一個章節（成片時間） */
export interface Chapter {
  t: number;
  title: string;
}

/** 發佈包（存在 Project.publish） */
export interface PublishKit {
  /** 文字的語言（zh、en…） */
  language: string;
  /** 三個標題選項 */
  titles: string[];
  /** 選中的標題（titles 的索引） */
  title: number;
  description: string;
  /** 重點條列 */
  highlights: string[];
  chapters: Chapter[];
  tags: string[];
}

/** 停頓多久就換行（秒） */
const LINE_GAP = 1;
/** 一行最長幾秒 */
const LINE_MAX = 12;
/** 章節對齊行首的容許誤差（秒） */
const SNAP = 5;
/** YouTube：相鄰章節至少幾秒 */
const MIN_CHAPTER = 10;
/** YouTube：至少幾個章節才會顯示 */
const MIN_CHAPTERS = 3;

/** 中日韓文字 */
const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

/** 兩段文字接起來：兩邊都是拉丁字才加空白 */
function join(a: string, b: string): string {
  if (!a) return b;
  return CJK.test(a.slice(-1)) || CJK.test(b.charAt(0)) ? a + b : `${a} ${b}`;
}

/** 成片逐字稿分行：停頓 ≥ 1 秒或一行超過 12 秒就換行 */
export function transcriptLines(words: TimelineWord[]): TranscriptLine[] {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const lines: TranscriptLine[] = [];
  let prevEnd = -Infinity;
  for (const word of sorted) {
    const text = word.text.trim();
    if (!text) continue;
    const cur = lines[lines.length - 1];
    if (!cur || word.start - prevEnd >= LINE_GAP || word.start - cur.t >= LINE_MAX) lines.push({ t: word.start, text });
    else cur.text = join(cur.text, text);
    prevEnd = word.end;
  }
  return lines;
}

/** 一行送出去約佔幾個字元（時間標記＋文字） */
const lineSize = (l: TranscriptLine) => l.text.length + 8;

/** 超過 maxChars 就從中間截掉（留頭尾各一半），回傳是否截過 */
export function trimLines(lines: TranscriptLine[], maxChars: number): { lines: TranscriptLine[]; trimmed: boolean } {
  if (lines.reduce((n, l) => n + lineSize(l), 0) <= maxChars) return { lines, trimmed: false };
  const head: TranscriptLine[] = [];
  const tail: TranscriptLine[] = [];
  let budget = maxChars;
  let i = 0;
  let j = lines.length - 1;
  // 頭尾輪流取，放不下就停
  while (i <= j) {
    const takeHead = head.length <= tail.length;
    const line = takeHead ? lines[i] : lines[j];
    if (lineSize(line) > budget) break;
    budget -= lineSize(line);
    if (takeHead) head.push(lines[i++]);
    else tail.unshift(lines[j--]);
  }
  return { lines: [...head, ...tail], trimmed: true };
}

/** 語言：中日韓文字佔非空白字元 30% 以上算 zh，否則 en */
export function detectLanguage(text: string): string {
  const chars = [...text.replace(/\s/g, "")];
  if (!chars.length) return "en";
  return chars.filter((c) => CJK.test(c)).length / chars.length >= 0.3 ? "zh" : "en";
}

/** 章節時間：m:ss，滿一小時 h:mm:ss */
export function formatChapterTime(t: number): string {
  const s = Math.floor(t);
  const two = (n: number) => String(n).padStart(2, "0");
  return s >= 3600 ? `${Math.floor(s / 3600)}:${two(Math.floor((s % 3600) / 60))}:${two(s % 60)}` : `${Math.floor(s / 60)}:${two(s % 60)}`;
}

/**
 * 整理模型給的章節：對齊最近的行首（±5 秒內沒有就丟）、第一個改成 0:00、排序、
 * 和前一個相距 < 10 秒或超過片長的丟掉；剩不到 3 個就整組不要（YouTube 不會顯示）。
 */
export function normalizeChapters(raw: Chapter[], lineStarts: number[], duration: number): Chapter[] {
  const snapped: Chapter[] = [];
  for (const c of raw) {
    let best: number | null = null;
    for (const s of lineStarts) if (Math.abs(s - c.t) <= SNAP && (best === null || Math.abs(s - c.t) < Math.abs(best - c.t))) best = s;
    if (best !== null && c.title.trim()) snapped.push({ t: best, title: c.title.trim() });
  }
  snapped.sort((a, b) => a.t - b.t);
  const out: Chapter[] = [];
  for (const c of snapped) {
    if (!out.length) out.push({ t: 0, title: c.title });
    else if (c.t - out[out.length - 1].t >= MIN_CHAPTER && c.t < duration) out.push(c);
  }
  return out.length >= MIN_CHAPTERS ? out : [];
}

/** 章節清單文字（一行一個「0:00 標題」；介面編輯用，也是 YouTube 說明欄的格式） */
export function chaptersToText(chapters: Chapter[]): string {
  return chapters.map((c) => `${formatChapterTime(c.t)} ${c.title}`).join("\n");
}

/** 使用者改過的章節文字 → 章節（看不懂的行略過） */
export function parseChapters(text: string): Chapter[] {
  const out: Chapter[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    out.push({ t: Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]), title: m[4] });
  }
  return out;
}

/** 貼到 YouTube 說明欄的文字：說明、重點條列、章節 */
export function youtubeDescription(kit: PublishKit): string {
  const parts = [kit.description.trim()];
  if (kit.highlights.length) parts.push(kit.highlights.map((h) => `• ${h}`).join("\n"));
  if (kit.chapters.length) parts.push(chaptersToText(kit.chapters));
  return parts.filter(Boolean).join("\n\n");
}

/** publish.md：選中的標題、備選標題、說明（含章節）、標籤 */
export function publishMarkdown(kit: PublishKit): string {
  const chosen = kit.titles[kit.title] ?? kit.titles[0] ?? "";
  const others = kit.titles.filter((_, i) => i !== kit.title);
  return [
    `# ${chosen}`,
    "",
    ...(others.length ? ["## Other title ideas", "", ...others.map((t) => `- ${t}`), ""] : []),
    "## Description",
    "",
    youtubeDescription(kit),
    "",
    "## Tags",
    "",
    kit.tags.join(", "),
    "",
  ].join("\n");
}
