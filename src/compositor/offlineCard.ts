// 「Media Offline」畫面（同達文西，2026-11-01）：原檔找不到的片段，預覽與匯出都畫這張卡代替影像，不擋播放、剪輯與匯出。
// 深紅底＋斜紋＋置中白字，一眼看得出是缺檔而不是黑畫面。依尺寸快取。

/** 已畫好的卡：「寬x高」→ 畫布 */
const cache = new Map<string, OffscreenCanvas>();

/** 取得 width×height 的離線卡（畫在圖層的位置，大小用輸出畫面的像素） */
export function offlineCard(width: number, height: number): OffscreenCanvas {
  const w = Math.max(16, Math.round(width));
  const h = Math.max(16, Math.round(height));
  const key = `${w}x${h}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#5a1010";
  ctx.fillRect(0, 0, w, h);
  // 斜紋
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = Math.max(4, h / 40);
  const step = Math.max(16, h / 10);
  for (let x = -h; x < w; x += step) {
    ctx.beginPath();
    ctx.moveTo(x, h);
    ctx.lineTo(x + h, 0);
    ctx.stroke();
  }
  ctx.fillStyle = "#ffffff";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.font = `600 ${Math.max(12, Math.round(h / 12))}px system-ui, sans-serif`;
  ctx.fillText("Media Offline", w / 2, h / 2);
  if (cache.size > 8) cache.clear();
  cache.set(key, canvas);
  return canvas;
}
