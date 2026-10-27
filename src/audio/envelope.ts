// 音量包絡（§5.13、§5.4）：每支有聲素材每 10 ms 一個 RMS 值。
// 時間軸的波形與配樂壓低（ducking）共用這份資料；它是由素材算出來的，不存進專案、不進復原歷史。

/** 包絡的取樣率：每秒幾個值 */
export const ENVELOPE_RATE = 100;

/** 一支素材的音量包絡（素材時間） */
export interface Envelope {
  /** 每秒幾個值 */
  rate: number;
  /** 每一格的 RMS（0～1） */
  rms: Float32Array;
}

/** 串流計算包絡：解碼出一段 PCM 就 push 一段，最後 finish（網頁版用；Windows 版在 Rust 算） */
export class EnvelopeBuilder {
  /** 每一格的樣本數 */
  private readonly window: number;
  private readonly values: number[] = [];
  /** 目前這一格累積的平方和與樣本數 */
  private sum = 0;
  private count = 0;

  constructor(sampleRate: number, private readonly rate: number = ENVELOPE_RATE) {
    this.window = Math.max(1, Math.round(sampleRate / rate));
  }

  /** 加入一段單聲道樣本（-1～1） */
  push(samples: Float32Array) {
    for (let i = 0; i < samples.length; i++) {
      this.sum += samples[i] * samples[i];
      if (++this.count === this.window) this.flush();
    }
  }

  /** 結束這一格 */
  private flush() {
    this.values.push(Math.sqrt(this.sum / this.count));
    this.sum = 0;
    this.count = 0;
  }

  /** 收尾（最後不滿一格的也算一格）並回傳包絡 */
  finish(): Envelope {
    if (this.count > 0) this.flush();
    return { rate: this.rate, rms: Float32Array.from(this.values) };
  }
}

/** 包絡在素材時間 s 的值；超出範圍回 0 */
export function envelopeAt(env: Envelope, s: number): number {
  const i = Math.floor(s * env.rate);
  return i >= 0 && i < env.rms.length ? env.rms[i] : 0;
}
