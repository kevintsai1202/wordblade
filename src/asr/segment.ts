// ASR 切段（spec §5.2）：Muse 一次最多 10 分鐘／32 MB，長片要在無聲處切開分批送。
// 每段不超過 max 秒；在上限前 search 秒內找最安靜的 0.3 秒切，找不到無聲處就硬切在上限。
import type { Envelope } from "../audio/envelope";
import type { Seconds } from "../core/model";
import { levelThreshold } from "./wordTiming";

/** 一段要送 ASR 的音訊（素材時間） */
export interface AsrSegment {
  start: Seconds;
  end: Seconds;
}

/** 找最安靜處用的平均視窗（秒） */
const QUIET_WINDOW = 0.3;

/** 在無聲處切成不超過 max 秒的段 */
export function splitAtSilence(env: Envelope, duration: Seconds, max: Seconds = 180, search: Seconds = 30): AsrSegment[] {
  const parts: AsrSegment[] = [];
  const threshold = levelThreshold(env);
  const win = Math.max(1, Math.round(QUIET_WINDOW * env.rate));
  let start = 0;
  while (duration - start > max) {
    const hi = start + max;
    const from = Math.max(0, Math.round((hi - search) * env.rate));
    const to = Math.min(env.rms.length, Math.round(hi * env.rate)) - win;
    let best = hi;
    let bestLevel = Infinity;
    for (let i = from; i <= to; i++) {
      let sum = 0;
      for (let k = i; k < i + win; k++) sum += env.rms[k];
      const level = sum / win;
      if (level < bestLevel) {
        bestLevel = level;
        best = (i + win / 2) / env.rate;
      }
    }
    // 視窗裡沒有無聲處：硬切在上限
    const cut = bestLevel < threshold ? Math.round(best * 100) / 100 : hi;
    parts.push({ start, end: cut });
    start = cut;
  }
  parts.push({ start, end: duration });
  return parts;
}
