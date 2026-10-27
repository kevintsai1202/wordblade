// 一鍵去贅詞（spec §5.16）與清除無聲片段（§5.16b）：純函式，找出要剪的素材範圍，交給使用者在確認清單勾選，
// 再一次用 cutRanges 剪掉（一筆編輯、一次 Ctrl+Z）。範圍一律用素材時間記，兩種可以一起剪。
import type { Envelope } from "../audio/envelope";
import { timelineWords } from "./captions";
import type { Project, Seconds } from "./model";
import { sourceToTimeline, WORD_PAD, type SourceRange } from "./timeline";

/** 預設的贅詞（英文與中文）；like、you know、那個、就是 有時是正常用詞，不預設 */
export const DEFAULT_FILLERS = ["um", "umm", "uh", "uhh", "erm", "ah", "hmm", "hm", "呃", "嗯", "欸"];

/** 清單裡的一條 */
export interface CleanupItem {
  /** 清單裡的唯一 id */
  id: string;
  kind: "filler" | "silence";
  mediaId: string;
  /** 要剪的素材範圍 */
  start: Seconds;
  end: Seconds;
  /** 時間軸上的位置（列表顯示與試聽用） */
  t: Seconds;
  /** 顯示文字（贅詞本身，或停頓長度） */
  label: string;
  /** 贅詞的詞 id */
  wordIds: string[];
}

/** 無聲段的參數 */
export interface SilenceOptions {
  /** RMS 低於這個值算無聲（0.01 約 -40 dBFS） */
  threshold: number;
  /** 至少持續幾秒才算 */
  minDuration: Seconds;
  /** 前後各留幾秒 */
  pad: Seconds;
}

export const DEFAULT_SILENCE: SilenceOptions = { threshold: 0.01, minDuration: 1.0, pad: 0.15 };

/** 比對用：小寫、去掉頭尾標點 */
const bare = (w: string) => w.toLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");

/** 素材時間 s 在 V1 哪個片段的時間軸位置（沒有回 null） */
function timelineOf(project: Project, mediaId: string, s: Seconds): Seconds | null {
  const v1 = project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  for (const clip of project.clips) {
    if (clip.trackId !== v1 || clip.mediaId !== mediaId) continue;
    const t = sourceToTimeline(clip, s);
    if (t !== null) return t;
  }
  return null;
}

/** 找 V1 上用到的贅詞：每個詞前後各留 0.05 秒，但不超過前後的詞（和改字即剪一樣） */
export function findFillers(project: Project, list: string[] = DEFAULT_FILLERS): CleanupItem[] {
  const wanted = new Set(list.map(bare));
  const onV1 = new Set(timelineWords(project).map((w) => w.id));
  const items: CleanupItem[] = [];
  const byMedia = new Map<string, typeof project.words>();
  for (const w of project.words) byMedia.set(w.mediaId, [...(byMedia.get(w.mediaId) ?? []), w]);
  for (const [mediaId, words] of byMedia) {
    const sorted = [...words].sort((a, b) => a.start - b.start);
    sorted.forEach((w, i) => {
      if (!onV1.has(w.id) || !wanted.has(bare(w.text))) return;
      const start = Math.max(w.start - WORD_PAD, sorted[i - 1]?.end ?? 0);
      const end = Math.min(w.end + WORD_PAD, sorted[i + 1]?.start ?? Infinity);
      items.push({ id: `filler:${w.id}`, kind: "filler", mediaId, start, end, t: timelineOf(project, mediaId, start) ?? 0, label: w.text, wordIds: [w.id] });
    });
  }
  return items.sort((a, b) => a.t - b.t);
}

/**
 * 找 V1 片段裡的無聲段：包絡低於門檻且持續 ≥ minDuration；前後各留 pad；和詞重疊就縮到詞的邊界（詞在中間就拆成兩段）。
 * 沒有逐字稿也能用（只看包絡）。envelopes：素材 id → 音量包絡（素材庫算好的，不在專案裡）。
 */
export function findSilences(project: Project, envelopes: Map<string, Envelope>, options: Partial<SilenceOptions> = {}): CleanupItem[] {
  const o = { ...DEFAULT_SILENCE, ...options };
  const v1 = project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  const items: CleanupItem[] = [];
  for (const clip of project.clips) {
    const env = envelopes.get(clip.mediaId);
    if (clip.trackId !== v1 || clip.freeze || !env) continue;
    const words = project.words.filter((w) => w.mediaId === clip.mediaId);
    const from = Math.floor(clip.srcIn * env.rate);
    const to = Math.min(env.rms.length, Math.ceil(clip.srcOut * env.rate));
    let run = -1;
    for (let i = from; i <= to; i++) {
      const quiet = i < to && env.rms[i] < o.threshold;
      if (quiet && run < 0) run = i;
      if (quiet || run < 0) continue;
      const a = run / env.rate;
      const b = i / env.rate;
      run = -1;
      if (b - a < o.minDuration) continue;
      // 前後留 pad，再避開詞
      let parts: [Seconds, Seconds][] = [[Math.max(clip.srcIn, a + o.pad), Math.min(clip.srcOut, b - o.pad)]];
      for (const w of words) {
        parts = parts.flatMap(([s, e]): [Seconds, Seconds][] => {
          if (w.end <= s || w.start >= e) return [[s, e]];
          return [[s, Math.min(e, w.start)], [Math.max(s, w.end), e]].filter(([x, y]) => y - x > 0.05) as [Seconds, Seconds][];
        });
      }
      for (const [s, e] of parts) {
        if (e - s < 0.2) continue;
        const t = sourceToTimeline(clip, s) ?? 0;
        items.push({ id: `silence:${clip.id}:${s.toFixed(2)}`, kind: "silence", mediaId: clip.mediaId, start: s, end: e, t, label: `${(e - s).toFixed(1)} s pause`, wordIds: [] });
      }
    }
  }
  return items.sort((a, b) => a.t - b.t);
}

/** 勾選的條目 → cutRanges 編輯要的素材範圍 */
export function toCutRanges(items: CleanupItem[]): SourceRange[] {
  return items.map((i) => ({ mediaId: i.mediaId, start: i.start, end: i.end }));
}
