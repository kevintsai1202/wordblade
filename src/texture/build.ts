// 材質後處理的瀏覽器接口（spec §5.12，P1-14）：解碼模型給的圖 → process.ts 的純函式 → 編成 PNG。
// 在主執行緒做（沙盒 CSP 的 worker-src 只放行 blob:，打包的 Worker 會被擋）：1024×1024 每個步驟約幾十到幾百 ms，步驟之間讓出一次，介面不至於卡住不動。
import { downscale, flattenVignette, makeSeamless, normalMap, type Pixels } from "./process";

/** 材質圖的邊長（模型給 1600×1600，縮成 1024） */
export const TEXTURE_SIZE = 1024;
/** 產生法線圖用的強度（圖裡畫好；之後在 Inspector 調的是插件的 normalScale，不重算圖片） */
export const NORMAL_STRENGTH = 2;
/** 3D 背景的寬（高依比例，模型給約 2016×1152） */
export const BACKGROUND_WIDTH = 1920;

/** 讓出主執行緒一次（讓畫面更新、按鈕狀態顯示） */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 圖片 Blob → ImageBitmap（沒有色彩轉換，避免法線等資料被動手腳） */
function decode(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { colorSpaceConversion: "none" });
}

/** ImageBitmap 畫到指定大小的 OffscreenCanvas 上 */
function drawn(bitmap: ImageBitmap, width: number, height: number): OffscreenCanvas {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, width, height);
  return canvas;
}

/** 讀出 RGBA 像素 */
function pixelsOf(canvas: OffscreenCanvas): Pixels {
  const image = canvas.getContext("2d")!.getImageData(0, 0, canvas.width, canvas.height);
  return { data: image.data, width: image.width, height: image.height };
}

/** RGBA 像素 → PNG 位元組 */
export async function encodePng(px: Pixels): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(px.width, px.height);
  canvas.getContext("2d")!.putImageData(new ImageData(px.data as Uint8ClampedArray<ArrayBuffer>, px.width, px.height), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * 材質：模型給的圖 → 縮成 1024 → 去暗角 → 無縫化 → 顏色圖與法線圖（都是 PNG）。
 * 模型給的圖是正方形；不是正方形的先硬縮成正方形（材質不在乎長寬比）。
 */
export async function buildTexture(blob: Blob, strength = NORMAL_STRENGTH): Promise<{ color: Uint8Array; normal: Uint8Array }> {
  const bitmap = await decode(blob);
  const size = Math.min(TEXTURE_SIZE, Math.max(bitmap.width, bitmap.height));
  // 先在 canvas 上縮到 ≤1024 的正方形（模型的大圖不必整張進 JS 迴圈），再交給純函式
  let px = downscale(pixelsOf(drawn(bitmap, size, size)), TEXTURE_SIZE);
  bitmap.close();
  await yieldToUi();
  px = flattenVignette(px);
  await yieldToUi();
  px = makeSeamless(px);
  await yieldToUi();
  const normal = normalMap(px, strength);
  return { color: await encodePng(px), normal: await encodePng(normal) };
}

/** 3D 背景：模型給的 16:9 圖 → 縮到寬 1920、高依比例（不做無縫化與法線），PNG */
export async function buildBackground(blob: Blob): Promise<Uint8Array> {
  const bitmap = await decode(blob);
  const width = Math.min(BACKGROUND_WIDTH, bitmap.width);
  const height = Math.max(1, Math.round((bitmap.height * width) / bitmap.width));
  const canvas = drawn(bitmap, width, height);
  bitmap.close();
  const out = await canvas.convertToBlob({ type: "image/png" });
  return new Uint8Array(await out.arrayBuffer());
}
