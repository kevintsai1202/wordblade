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
