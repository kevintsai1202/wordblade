// Muse ASR 的音訊格式（spec §5.2）：16 kHz 單聲道 16-bit PCM WAV。網頁版自己解碼、降取樣、編 WAV；Windows 版由 ffmpeg 直接輸出。

/** ASR 用的取樣率 */
export const ASR_RATE = 16000;

/**
 * 降取樣：每個輸出樣本取它涵蓋的輸入區間平均（盒狀濾波，順便擋掉大部分混疊；ASR 用夠了）。
 * 48 kHz → 16 kHz 就是每 3 個取平均。同取樣率原樣回傳。
 */
export function downsample(input: Float32Array, inRate: number, outRate: number = ASR_RATE): Float32Array {
  if (inRate === outRate) return input;
  const ratio = inRate / outRate;
  const out = new Float32Array(Math.floor(input.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const a = Math.floor(i * ratio);
    const b = Math.min(input.length, Math.max(a + 1, Math.floor((i + 1) * ratio)));
    let sum = 0;
    for (let k = a; k < b; k++) sum += input[k];
    out[i] = sum / (b - a);
  }
  return out;
}

/** 已經是 16-bit little-endian 的單聲道 PCM（Windows 版 ffmpeg 的輸出）補上 WAV 檔頭 */
export function pcm16ToWav(pcm: Uint8Array, rate: number = ASR_RATE): Uint8Array {
  const header = encodeWav(new Float32Array(0), rate);
  const bytes = new Uint8Array(44 + pcm.length);
  bytes.set(header);
  bytes.set(pcm, 44);
  const view = new DataView(bytes.buffer);
  view.setUint32(4, 36 + pcm.length, true);
  view.setUint32(40, pcm.length, true);
  return bytes;
}

/** 單聲道樣本（-1～1，超出的夾住）編成 16-bit PCM WAV */
export function encodeWav(samples: Float32Array, rate: number = ASR_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < 4; i++) bytes[at + i] = s.charCodeAt(i); };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // 單聲道
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
  }
  return bytes;
}

/** 解開的 WAV：格式與 PCM 資料（只支援 PCM；多聲道、16-bit 以外也照原樣帶著） */
export interface WavPcm {
  rate: number;
  channels: number;
  bits: number;
  /** data 區塊的原始位元組 */
  data: Uint8Array;
}

/** 解析 WAV 檔：找 fmt 與 data 區塊（容許中間有 LIST 等其他區塊）；不是 PCM WAV 就丟錯 */
export function parseWav(wav: Uint8Array): WavPcm {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (at: number) => String.fromCharCode(wav[at], wav[at + 1], wav[at + 2], wav[at + 3]);
  if (wav.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("Not a WAV file");
  let fmt: { rate: number; channels: number; bits: number } | null = null;
  for (let at = 12; at + 8 <= wav.length;) {
    const size = view.getUint32(at + 4, true);
    const body = at + 8;
    if (tag(at) === "fmt ") {
      if (view.getUint16(body, true) !== 1) throw new Error("Only PCM WAV is supported");
      fmt = { channels: view.getUint16(body + 2, true), rate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) };
    } else if (tag(at) === "data" && fmt) {
      // 串流寫出的檔 data 長度可能是 0 或超出檔尾：夾在檔案實際長度內
      const end = size === 0 || body + size > wav.length ? wav.length : body + size;
      return { ...fmt, data: wav.subarray(body, end) };
    }
    at = body + size + (size & 1);
  }
  throw new Error("The WAV has no audio data");
}

/** 把多個 WAV 的 PCM 資料首尾相接成一個 WAV；格式（取樣率、聲道、位元數）必須相同，否則丟錯 */
export function concatWav(wavs: Uint8Array[]): Uint8Array {
  if (!wavs.length) throw new Error("Nothing to concatenate");
  const parts = wavs.map(parseWav);
  const first = parts[0];
  for (const p of parts) if (p.rate !== first.rate || p.channels !== first.channels || p.bits !== first.bits) throw new Error("The WAV files have different formats");
  const total = parts.reduce((n, p) => n + p.data.length, 0);
  const out = new Uint8Array(44 + total);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => { for (let i = 0; i < 4; i++) out[at + i] = s.charCodeAt(i); };
  const align = first.channels * (first.bits >> 3);
  ascii(0, "RIFF");
  view.setUint32(4, 36 + total, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, first.channels, true);
  view.setUint32(24, first.rate, true);
  view.setUint32(28, first.rate * align, true);
  view.setUint16(32, align, true);
  view.setUint16(34, first.bits, true);
  ascii(36, "data");
  view.setUint32(40, total, true);
  let at = 44;
  for (const p of parts) {
    out.set(p.data, at);
    at += p.data.length;
  }
  return out;
}
