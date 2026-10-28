// 漸進式縮圖（spec §5.13，D39，開發者 2026-10-28）：匯入時先做大間隔、低解析的第一層，空檔再做更密、更大的兩層。
// 用在拖曳播放頭時先顯示縮圖、時間軸片段的影格條、AI 取畫面。這裡只放純函式（分層、分段、挑哪一張、下一件工作），
// 產生與快取由 Engine 負責（桌面 ffmpeg 寫到快取資料夾、網頁 WebCodecs 寫到 OPFS）。

/** 一層縮圖：每隔幾秒（素材時間）一張、寬幾像素 */
export interface ThumbTier {
  interval: number;
  width: number;
}

/** 三層：匯入時每 10 秒寬 160 → 空檔每 2 秒寬 320 → 每 0.5 秒寬 480 */
export const TIERS: ThumbTier[] = [
  { interval: 10, width: 160 },
  { interval: 2, width: 320 },
  { interval: 0.5, width: 480 },
];

/** 每段幾秒：一次產生一段，段之間可以停下來讓給播放與其他重工作；60 被三種間隔整除，索引都是整數 */
export const CHUNK = 60;

/** 各層做好的段（DoneMap[層] = 段號清單） */
export type DoneMap = number[][];

/** 一張縮圖的位置 */
export interface ThumbRef {
  tier: number;
  index: number;
  /** 素材時間（＝索引 × 間隔） */
  time: number;
}

/** 一支素材要分幾段（不足一段也算一段） */
export function chunkCount(duration: number): number {
  return Math.max(1, Math.ceil(duration / CHUNK - 1e-9));
}

/** 某一層某一段包含的縮圖索引（時間 = 索引 × 間隔，小於片長；片長 0 時至少有第 0 張） */
export function indicesInChunk(tier: number, chunk: number, duration: number): number[] {
  const { interval } = TIERS[tier];
  const per = CHUNK / interval;
  const first = chunk * per;
  const out: number[] = [];
  for (let i = first; i < first + per && (i * interval < duration - 1e-9 || i === 0); i++) out.push(i);
  return out;
}

/** 某一層最後一張的索引 */
function lastIndex(tier: number, duration: number): number {
  const { interval } = TIERS[tier];
  return Math.max(0, Math.ceil(duration / interval - 1e-9) - 1);
}

/**
 * 素材時間 t 要顯示哪一張：從最細的一層往粗找，用 t 所在的段已經做好的那一層、最近的一張。
 * 四捨五入跑到下一段而下一段還沒做好時，退回這一段的最後一張；不超過片長。都沒做好回 null。
 */
export function pickThumb(done: DoneMap, duration: number, t: number): ThumbRef | null {
  const time = Math.max(0, Math.min(t, duration));
  const chunk = Math.min(Math.floor(time / CHUNK), chunkCount(duration) - 1);
  for (let tier = TIERS.length - 1; tier >= 0; tier--) {
    const chunks = done[tier] ?? [];
    if (!chunks.includes(chunk)) continue;
    const { interval } = TIERS[tier];
    let index = Math.min(Math.round(time / interval), lastIndex(tier, duration));
    if (!chunks.includes(Math.floor((index * interval) / CHUNK))) index = Math.min(Math.floor(time / interval), lastIndex(tier, duration));
    return { tier, index, time: index * interval };
  }
  return null;
}

/** 排程看的素材 */
export interface ThumbItem {
  mediaId: string;
  duration: number;
  done: DoneMap;
}

/** 一件工作：某支素材某一層的某一段 */
export interface ThumbJob {
  mediaId: string;
  tier: number;
  chunk: number;
}

/** 下一件工作：先把所有素材的粗層做完再做細層；同一層依素材、段的順序。只看 minTier～maxTier；都做完回 null */
export function nextJob(items: ThumbItem[], minTier = 0, maxTier = TIERS.length - 1): ThumbJob | null {
  for (let tier = minTier; tier <= maxTier; tier++) {
    for (const item of items) {
      const done = item.done[tier] ?? [];
      for (let chunk = 0; chunk < chunkCount(item.duration); chunk++) {
        if (!done.includes(chunk)) return { mediaId: item.mediaId, tier, chunk };
      }
    }
  }
  return null;
}
