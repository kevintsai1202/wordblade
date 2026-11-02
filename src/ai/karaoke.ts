// 卡拉 OK 重配錄音（spec §5.18，P1-9；2026-11-02）：提詞器的逐字時間。純函式。
// 文字沒改：照原本逐字稿的詞時間（講者原本的節奏）；改過：依字數平均分到整段範圍。時間都相對範圍起點。
import type { Project, Seconds } from "../core/model";
import { joinWords, timelineWords } from "../core/captions";

/** 提詞器的一個詞（相對範圍起點的秒數） */
export interface PrompterWord {
  text: string;
  start: Seconds;
  end: Seconds;
}

/** 範圍內每個詞要在什麼時候亮 */
export function prompterWords(project: Project, range: { start: Seconds; end: Seconds }, text: string): PrompterWord[] {
  const length = range.end - range.start;
  const inRange = timelineWords(project).filter((w) => (w.start + w.end) / 2 >= range.start && (w.start + w.end) / 2 < range.end);
  // 文字和範圍內的原字相同：照原本的時間
  if (inRange.length && joinWords(inRange.map((w) => w.text)) === text.trim()) {
    return inRange.map((w) => ({
      text: w.text,
      start: Math.max(0, w.start - range.start),
      end: Math.min(length, w.end - range.start),
    }));
  }
  const parts = text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((n, w) => n + w.length, 0) || 1;
  let at = 0;
  return parts.map((w) => {
    const dur = (length * w.length) / total;
    const word = { text: w, start: at, end: at + dur };
    at += dur;
    return word;
  });
}

/** 時間 t（相對範圍起點）念到第幾個詞：還沒到第一個是 −1，最後一個之後停在最後一個 */
export function activeWordIndex(words: PrompterWord[], t: Seconds): number {
  let k = -1;
  for (let i = 0; i < words.length; i++) if (t >= words[i].start) k = i;
  return k;
}
