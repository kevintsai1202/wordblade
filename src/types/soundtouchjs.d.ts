// soundtouchjs 沒有型別宣告：只宣告匯出混音用到的部分（spec §5.4 的 WSOLA 時間伸縮）
declare module "soundtouchjs" {
  /** 雙聲道交錯的樣本佇列 */
  interface FifoSampleBuffer {
    readonly frameCount: number;
    putSamples(samples: Float32Array, position?: number, numFrames?: number): void;
    receiveSamples(output: Float32Array, numFrames?: number): void;
  }
  /** 變速（tempo）、變調（pitch）、重新取樣（rate） */
  export class SoundTouch {
    tempo: number;
    rate: number;
    pitch: number;
    readonly inputBuffer: FifoSampleBuffer;
    readonly outputBuffer: FifoSampleBuffer;
    process(): void;
    clear(): void;
  }
}
