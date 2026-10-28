// SAM 請求的規劃（spec §5.3，docs/plan-10-28-sam.md）：小檔尺寸、長範圍分段、估價。純函式。

/** 一次請求最長幾秒：閘道上傳上限 33 MB，1280 寬每秒 10 格時約 100～280 秒，留餘裕 */
export const MAX_CHUNK_SECONDS = 90;
/** 每千格的價格（US$；2026-10-28 實測計費格數＝送出的格數，但每次至少 50 格） */
const USD_PER_FRAME = 0.2 / 1000;
const MIN_BILLED = 50;

/** 小檔尺寸：寬不超過 maxWidth、不放大、寬高都取偶數（H.264 要求） */
export function clipSize(width: number, height: number, maxWidth: number): { width: number; height: number } {
  const w = Math.min(width, maxWidth) & ~1;
  return { width: w, height: Math.round((height * w) / width) & ~1 };
}

/** 範圍 → 各次請求的起訖：每段最多 90 秒，下一段從上一段最後一格開始（重疊一格，用那一格的框把物件接起來） */
export function planChunks(start: number, end: number, fps: number): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let s = start;
  for (;;) {
    const e = Math.min(end, s + MAX_CHUNK_SECONDS);
    out.push({ start: s, end: e });
    if (e >= end) return out;
    s = e - 1 / fps;
  }
}

/** 估價（US$）：各次請求的格數 */
export function estimateUsd(frames: number[]): number {
  return frames.reduce((sum, n) => sum + Math.max(MIN_BILLED, n) * USD_PER_FRAME, 0);
}
