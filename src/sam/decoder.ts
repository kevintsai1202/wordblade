// SAM 3.1 遮罩（one_bit 編碼）的解碼：改寫自 Meta 的 meta_sam_parser 0.0.6（`_mask_codec._unpack` 與 `_decode_raster`），
// 經 transcript-review/backend/face_decode.py（2026-10-06，逐位元與官方相同）轉成 TypeScript。
//
// Copyright (c) Meta Platforms, Inc. and affiliates. 本檔是 SAM Materials 的衍生作品，依 SAM License 散布，
// 授權全文在 licenses/meta-sam-parser-LICENSE.txt（spec §3 第三方授權）。
//
// 格式：開頭 `!` 是 one_bit；之後是 base85（ASCII 33～123 扣掉 " , ; < > \ |，共 85 個字元）——開頭 5 字是位元組數，
// 每 5 字是 4 個位元組（大端），最後不足 4 個的補 84；位元組再用區間解碼器（Subbotin 式，自適應二元模型、12 位元上下文：
// 本列左兩格＋上一列與上上一列各五格）逐格解出 0／1。lossless（`~`）不支援，呼叫端改用框的橢圓。

/** base85 字元 → 值（0～84；原專案的表多了 } ~ 兩個字元，對應 85、86，這裡直接拒絕） */
const VALUES = new Map<string, number>();
for (let c = 0x21, i = 0; c < 0x7f; c++) {
  const ch = String.fromCharCode(c);
  if ('"\\,;<>|'.includes(ch)) continue;
  if (i < 85) VALUES.set(ch, i);
  i++;
}

const RADIX = 85;
/** 開頭 5 個字元是解出來的位元組數 */
const PREFIX = 5;
const TOP = 1 << 24;
const BOTTOM = 1 << 16;
/** 每次出現在某個上下文，該位元的計數加多少 */
const INCREMENT = 14;
/** 兩個計數加起來到這個數就各自減半 */
const COUNT_LIMIT = 4096;
/** 上下文的個數（12 位元） */
const CONTEXTS = 1 << 12;
/** 一個遮罩最多幾個像素（擋掉損壞或惡意的尺寸） */
export const MAX_AREA = 4096 * 4096;
const TWO32 = 2 ** 32;

/** 一個 base85 字元的值；不合法丟錯 */
function digit(ch: string | undefined): number {
  const v = ch === undefined ? undefined : VALUES.get(ch);
  if (v === undefined) throw new Error("SAM mask: bad character");
  return v;
}

/** base85 → 位元組 */
function unpack(text: string): Uint8Array {
  if (text.length < PREFIX) throw new Error("SAM mask: no length");
  let length = 0;
  for (let i = 0; i < PREFIX; i++) length = length * RADIX + digit(text[i]);
  const rem = length % 4;
  if (text.length !== PREFIX + Math.floor(length / 4) * 5 + (rem ? rem + 1 : 0)) throw new Error("SAM mask: length mismatch");
  const out = new Uint8Array(length);
  let src = PREFIX;
  let dst = 0;
  const full = length - rem;
  while (dst < full) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * RADIX + digit(text[src + i]);
    if (v >= TWO32) throw new Error("SAM mask: out of range");
    out[dst] = Math.floor(v / 2 ** 24) & 255;
    out[dst + 1] = Math.floor(v / 2 ** 16) & 255;
    out[dst + 2] = Math.floor(v / 2 ** 8) & 255;
    out[dst + 3] = v & 255;
    src += 5;
    dst += 4;
  }
  if (rem) {
    let v = 0;
    for (let i = 0; i < 5; i++) v = v * RADIX + (i < rem + 1 ? digit(text[src + i]) : RADIX - 1);
    if (v >= TWO32) throw new Error("SAM mask: out of range");
    for (let i = 0; i < rem; i++) out[dst + i] = Math.floor(v / 2 ** (24 - 8 * i)) & 255;
  }
  return out;
}

/** one_bit 遮罩 → 列優先的 0／1（width × height） */
function decodeOneBit(payload: string, width: number, height: number): Uint8Array {
  const data = unpack(payload.slice(1));
  const n = data.length;
  if (n < 4) throw new Error("SAM mask: incomplete");
  let pos = 4;
  let code = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
  let low = 0;
  let rng = 0xffffffff;
  /** 每個上下文的（0 的計數, 1 的計數） */
  const counts = new Uint16Array(2 * CONTEXTS).fill(1);
  /** 左右各留 2 格 0、上面留 2 列 0、最後多 4 個位元組（最後一格往右上讀不越界） */
  const pw = width + 4;
  const padded = new Uint8Array(pw * (height + 2) + 4);
  for (let y = 0; y < height; y++) {
    const row = (y + 2) * pw + 2;
    const prior = row - pw;
    const earlier = row - 2 * pw;
    // 上一列、上上一列各 5 位元（第 x−2～x+2 格），本列 2 位元（左一格、左兩格）
    let a = padded[prior - 2] | (padded[prior - 1] << 1) | (padded[prior] << 2) | (padded[prior + 1] << 3) | (padded[prior + 2] << 4);
    let e = padded[earlier - 2] | (padded[earlier - 1] << 1) | (padded[earlier] << 2) | (padded[earlier + 1] << 3) | (padded[earlier + 2] << 4);
    let cur = 0;
    let p = row;
    for (let x = 0; x < width; x++) {
      const off = (cur | (a << 2) | (e << 7)) << 1;
      let zero = counts[off];
      let one = counts[off + 1];
      const scaled = Math.floor(rng / (zero + one));
      if (!scaled) throw new Error("SAM mask: bad coding state");
      let bit: number;
      if (Math.floor(((code - low) >>> 0) / scaled) < zero) {
        bit = 0;
        rng = scaled * zero;
        counts[off] = zero = zero + INCREMENT;
      } else {
        bit = 1;
        low = (low + scaled * zero) % TWO32;
        rng = scaled * one;
        counts[off + 1] = one = one + INCREMENT;
      }
      if (zero + one >= COUNT_LIMIT) {
        counts[off] = zero >> 1 || 1;
        counts[off + 1] = one >> 1 || 1;
      }
      // 區間正規化：每移出一個位元組就讀入一個
      for (;;) {
        if ((low ^ ((low + rng) % TWO32)) >>> 0 < TOP) {
          /* 最高位元組已定 */
        } else if (rng < BOTTOM) {
          rng = (-low >>> 0) & (BOTTOM - 1);
        } else {
          break;
        }
        if (pos >= n) throw new Error("SAM mask: ended early");
        code = ((code * 256) + data[pos++]) % TWO32;
        low = (low * 256) % TWO32;
        rng = (rng * 256) % TWO32;
      }
      if (bit) padded[p] = 1;
      cur = ((cur << 1) & 2) | bit;
      p++;
      a = (a >> 1) | (padded[p - pw + 2] << 4);
      e = (e >> 1) | (padded[p - 2 * pw + 2] << 4);
    }
  }
  if (pos !== n) throw new Error("SAM mask: not fully read");
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) out.set(padded.subarray((y + 2) * pw + 2, (y + 2) * pw + 2 + width), y * width);
  return out;
}

/** SAM 遮罩記錄的內容（data=H,W,<內容>）→ 列優先的 0／1；內容或尺寸不對一律丟錯（呼叫端改用框的橢圓） */
export function decodeMask(payload: string, width: number, height: number): Uint8Array {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0 || width * height > MAX_AREA) throw new Error("SAM mask: bad size");
  if (!payload) throw new Error("SAM mask: empty");
  if (payload[0] === "!") return decodeOneBit(payload, width, height);
  throw new Error(payload[0] === "~" ? "SAM mask: lossless encoding not supported" : "SAM mask: unknown encoding");
}
