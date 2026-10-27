// 截目前預覽這一格（給 AI 當參考圖）：縮成 960 寬的 JPEG data URL（小於 64 px 的圖 Muse 會默默丟掉）。

/** 截預覽畫面；找不到畫布回 null */
export function captureFrame(): string | null {
  const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="preview-canvas"]');
  if (!canvas) return null;
  const out = document.createElement("canvas");
  out.width = 960;
  out.height = Math.round((960 * canvas.height) / canvas.width);
  out.getContext("2d")!.drawImage(canvas, 0, 0, out.width, out.height);
  return out.toDataURL("image/jpeg", 0.8);
}
