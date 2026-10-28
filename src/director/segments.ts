// AI 導演的切段（spec §5.11）：依逐字稿的停頓把素材切成約 2 分鐘一段（90～150 秒），每段送 Muse Spark 看一次。
// 切點選在範圍內最長的停頓中間（同樣長選離 120 秒近的），講到一半的句子不會被切開；沒有逐字稿就每 120 秒一段。
import type { Seconds, Word } from "../core/model";

/** 一段的長度限制（秒） */
const MIN = 90;
const TARGET = 120;
const MAX = 150;

/** 素材的詞（依時間）與片長 → 各段起訖（素材時間，首尾相接） */
export function planSegments(words: Word[], duration: Seconds): { start: Seconds; end: Seconds }[] {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const out: { start: Seconds; end: Seconds }[] = [];
  let s = 0;
  while (duration - s > MAX) {
    /** 範圍內的停頓：前一個詞結尾到下一個詞開頭 */
    let best: { at: number; gap: number } | null = null;
    for (let i = 1; i < sorted.length; i++) {
      const at = (sorted[i - 1].end + sorted[i].start) / 2;
      if (at <= s + MIN || at >= s + MAX) continue;
      const gap = sorted[i].start - sorted[i - 1].end;
      if (!best || gap > best.gap + 1e-9 || (Math.abs(gap - best.gap) < 1e-9 && Math.abs(at - s - TARGET) < Math.abs(best.at - s - TARGET))) best = { at, gap };
    }
    const end = Math.round((best && best.gap > 0 ? best.at : s + TARGET) * 1000) / 1000;
    out.push({ start: s, end });
    s = end;
  }
  out.push({ start: s, end: duration });
  return out;
}
