import { describe, expect, it } from "vitest";
import { downscale, edgeSeam, flattenVignette, makeSeamless, normalMap, type Pixels } from "./process";

// 材質後處理（spec §5.12，P1-14）：純函式（RGBA 陣列），Node 沒有 OffscreenCanvas 也能測。

/** 一張 w×h、每格由 f(x, y) 給 [r, g, b] 的圖 */
function image(w: number, h: number, f: (x: number, y: number) => [number, number, number]): Pixels {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const [r, g, b] = f(x, y);
    data.set([r, g, b, 255], (y * w + x) * 4);
  }
  return { data, width: w, height: h };
}

describe("材質後處理", () => {
  it("縮小：尺寸對、平均顏色不變", () => {
    const src = image(64, 64, () => [200, 100, 50]);
    const out = downscale(src, 16);
    expect([out.width, out.height]).toEqual([16, 16]);
    expect(Array.from(out.data.slice(0, 4))).toEqual([200, 100, 50, 255]);
  });

  it("無縫化：左右、上下邊緣的差低於門檻（原圖是左暗右亮的漸層，接縫很明顯）", () => {
    const src = image(64, 64, (x, y) => [x * 4, y * 4, 128]);
    expect(edgeSeam(src)).toBeGreaterThan(60);
    expect(edgeSeam(makeSeamless(src))).toBeLessThan(12);
  });

  it("去暗角：四周偏暗的圖拉平後，角落和中央的亮度差變小", () => {
    const src = image(64, 64, (x, y) => {
      const d = Math.hypot(x - 32, y - 32) / 45;
      const v = Math.round(180 * (1 - 0.6 * d * d));
      return [v, v, v];
    });
    const lum = (p: Pixels, x: number, y: number) => p.data[(y * p.width + x) * 4];
    const before = lum(src, 32, 32) - lum(src, 1, 1);
    const flat = flattenVignette(src);
    const after = Math.abs(lum(flat, 32, 32) - lum(flat, 1, 1));
    expect(before).toBeGreaterThan(60);
    expect(after).toBeLessThan(before / 3);
  });

  it("法線貼圖：全平的圖是 (128,128,255)；強度 0 也是平的；有坡度時 x 分量偏離 128", () => {
    const flat = normalMap(image(16, 16, () => [90, 90, 90]), 1);
    expect(Array.from(flat.data.slice(0, 3))).toEqual([128, 128, 255]);
    const ramp = image(16, 16, (x) => [x * 16, x * 16, x * 16]);
    expect(Array.from(normalMap(ramp, 0).data.slice(4 * 20, 4 * 20 + 3))).toEqual([128, 128, 255]);
    expect(Math.abs(normalMap(ramp, 2).data[4 * 20] - 128)).toBeGreaterThan(10);
  });
});
