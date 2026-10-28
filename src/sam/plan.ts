// SAM 請求的規劃（spec §5.3，docs/plan-10-28-sam.md）：小檔尺寸、長範圍分段、估價。純函式。

/** 一次請求最長幾秒：閘道上傳上限 33 MB，1280 寬每秒 10 格時約 100～280 秒，留餘裕 */
export const MAX_CHUNK_SECONDS = 90;
/**
 * 小檔的位元率（bps）：每秒 10 格時每格約 19 KB（原專案 ffmpeg crf 20 實測 12～33 KB／格），
 * 90 秒一段約 17 MB，穩穩低於閘道 33 MB 的上傳上限（不設的話動態大的畫面可能超過、整次 413）
 */
export const CLIP_BITRATE = 1_500_000;
/** 閘道的上傳上限（位元組） */
export const GATEWAY_UPLOAD_LIMIT = 33 * 1024 * 1024;

/** 每千格的價格（US$；2026-10-28 實測計費格數＝送出的格數，但每次至少 50 格） */
const USD_PER_FRAME = 0.2 / 1000;
const MIN_BILLED = 50;

/** 小檔尺寸：寬不超過 maxWidth、高不超過 maxHeight（有給的話）、不放大、寬高都取偶數（H.264 要求） */
export function clipSize(width: number, height: number, maxWidth: number, maxHeight = Infinity): { width: number; height: number } {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  // 被高度限制時先定高度（480 就是 480），寬依比例；否則先定寬度
  if (scale < 1 && scale === maxHeight / height) {
    const h = Math.round(height * scale) & ~1;
    return { width: Math.round((width * h) / height) & ~1, height: h };
  }
  const w = Math.round(width * scale) & ~1;
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
