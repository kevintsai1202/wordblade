// 材質後處理（spec §5.12，D36，P1-14）：Muse Image 給的材質不保證無縫、四周常偏暗，這裡自己處理。
// 全部是 RGBA 陣列上的純函式（Node 也能測）；解碼與編碼（ImageBitmap、canvas）在 texture/build.ts。
//   1. downscale：縮成 1024×1024（模型給 1600×1600）
//   2. flattenVignette：大半徑模糊取低頻亮度，除掉後拉平（去暗角）
//   3. makeSeamless：原圖與位移半張的三份依離邊緣遠近混合（四邊接得起來、裡面也沒有接縫）
//   4. normalMap：亮度當高度、Sobel 算斜率（強度 0 就是平的）

/** 一張圖：RGBA，每格 4 個位元組 */
export interface Pixels {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** 新的空白圖 */
function blank(width: number, height: number): Pixels {
  return { data: new Uint8ClampedArray(width * height * 4), width, height };
}

/** 縮成 size×size（區域平均，夠快也不會鋸齒）；比 size 小就照原樣 */
export function downscale(src: Pixels, size: number): Pixels {
  if (src.width <= size && src.height <= size) return src;
  const out = blank(size, size);
  const sx = src.width / size;
  const sy = src.height / size;
  for (let y = 0; y < size; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.floor((y + 1) * sy));
    for (let x = 0; x < size; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.floor((x + 1) * sx));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = (yy * src.width + xx) * 4;
        r += src.data[i]; g += src.data[i + 1]; b += src.data[i + 2]; a += src.data[i + 3]; n++;
      }
      out.data.set([r / n, g / n, b / n, a / n], (y * size + x) * 4);
    }
  }
  return out;
}

/** 亮度（0～255） */
function luma(d: Uint8ClampedArray, i: number): number {
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
}

/** 一維方框模糊（半徑 r，邊緣夾住），用累加和 O(n) */
function boxBlur1D(src: Float32Array, dst: Float32Array, n: number, stride: number, offset: number, r: number) {
  let acc = 0;
  const at = (k: number) => src[offset + Math.min(n - 1, Math.max(0, k)) * stride];
  for (let k = -r; k <= r; k++) acc += at(k);
  for (let k = 0; k < n; k++) {
    dst[offset + k * stride] = acc / (2 * r + 1);
    acc += at(k + r + 1) - at(k - r);
  }
}

/** 亮度圖的大半徑模糊（橫、直各三次方框模糊 ≈ 高斯） */
function lowFrequency(src: Pixels, radius: number): Float32Array {
  const { width: w, height: h } = src;
  let a = new Float32Array(w * h);
  let b = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = luma(src.data, i * 4);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) boxBlur1D(a, b, w, 1, y * w, radius);
    [a, b] = [b, a];
    for (let x = 0; x < w; x++) boxBlur1D(a, b, h, w, x, radius);
    [a, b] = [b, a];
  }
  return a;
}

/** 去暗角：每格乘上（整體平均亮度 ÷ 該處的低頻亮度），四周偏暗的部分拉回來；細節（高頻）不動 */
export function flattenVignette(src: Pixels): Pixels {
  const low = lowFrequency(src, Math.max(2, Math.round(Math.min(src.width, src.height) / 16)));
  let mean = 0;
  for (const v of low) mean += v;
  mean /= low.length;
  const out = blank(src.width, src.height);
  for (let i = 0; i < low.length; i++) {
    const k = mean / Math.max(8, low[i]);
    out.data[i * 4] = src.data[i * 4] * k;
    out.data[i * 4 + 1] = src.data[i * 4 + 1] * k;
    out.data[i * 4 + 2] = src.data[i * 4 + 2] * k;
    out.data[i * 4 + 3] = src.data[i * 4 + 3];
  }
  return out;
}

/**
 * 無縫化（offset-and-blend，四份）：原圖 A、橫移半張 B、直移半張 C、兩邊都移 D，依離邊緣多遠混合：
 * wx 在左右邊緣是 0、中央是 1（wy 同理），out = wx·wy·A + (1−wx)·wy·B + wx·(1−wy)·C + (1−wx)(1−wy)·D。
 * 左右邊緣只剩 B、D（橫向本來就接得起來），上下邊緣只剩 C、D；每份自己的接縫剛好落在它權重是 0 的地方，所以看不出縫。
 */
export function makeSeamless(src: Pixels): Pixels {
  const { width: w, height: h, data } = src;
  const out = blank(w, h);
  /** 0～1：離邊緣多遠（邊緣 0、中央 1，平滑） */
  const weight = (p: number, size: number) => {
    const t = 1 - Math.abs((2 * (p + 0.5)) / size - 1);
    return t * t * (3 - 2 * t);
  };
  const hw = Math.floor(w / 2);
  const hh = Math.floor(h / 2);
  for (let y = 0; y < h; y++) {
    const wy = weight(y, h);
    const y2 = (y + hh) % h;
    for (let x = 0; x < w; x++) {
      const wx = weight(x, w);
      const x2 = (x + hw) % w;
      const a = (y * w + x) * 4, b = (y * w + x2) * 4, c = (y2 * w + x) * 4, d = (y2 * w + x2) * 4;
      const ka = wx * wy, kb = (1 - wx) * wy, kc = wx * (1 - wy), kd = (1 - wx) * (1 - wy);
      for (let k = 0; k < 4; k++) out.data[a + k] = data[a + k] * ka + data[b + k] * kb + data[c + k] * kc + data[d + k] * kd;
    }
  }
  return out;
}

/** 接縫差：右邊緣對左邊緣、下邊緣對上邊緣的平均絕對差（每個顏色分量），越小越看不出接縫 */
export function edgeSeam(src: Pixels): number {
  const { width: w, height: h, data } = src;
  let sum = 0, n = 0;
  for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) {
    sum += Math.abs(data[(y * w + w - 1) * 4 + c] - data[(y * w) * 4 + c]);
    n++;
  }
  for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {
    sum += Math.abs(data[((h - 1) * w + x) * 4 + c] - data[x * 4 + c]);
    n++;
  }
  return sum / n;
}

/** 法線貼圖：亮度當高度，Sobel（四邊環繞，材質本來就要拼接）算斜率；strength 0 是平的 (128,128,255) */
export function normalMap(src: Pixels, strength: number): Pixels {
  const { width: w, height: h } = src;
  const height = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) height[i] = luma(src.data, i * 4) / 255;
  const at = (x: number, y: number) => height[((y + h) % h) * w + ((x + w) % w)];
  const out = blank(w, h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const dx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
    const dy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1)) - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
    let nx = -dx * strength, ny = -dy * strength, nz = 1;
    const len = Math.hypot(nx, ny, nz);
    nx /= len; ny /= len; nz /= len;
    out.data.set([Math.round((nx * 0.5 + 0.5) * 255), Math.round((ny * 0.5 + 0.5) * 255), Math.round((nz * 0.5 + 0.5) * 255), 255], (y * w + x) * 4);
  }
  return out;
}
