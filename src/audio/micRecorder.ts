// 麥克風錄音（spec §5.18；P1-9 卡拉 OK 重配錄音還沒做，這裡是單純錄一段）：
// 預設用 getUserMedia＋MediaRecorder，錄完解碼成 48 kHz 單聲道 WAV（走和 AI 音效一樣的匯入流程）。
// Windows 版遇到 NotReadableError、NotAllowedError 或 8 秒沒拿到麥克風時，改用內建錄音機（Engine.recorderFallback）；
// NotFoundError（沒有麥克風）不退，直接提示；網頁版沒有退路。錄完檢查峰值，削峰時提示。
import { SYNTH_RATE, synthToWav } from "./synth/render";

/** 等麥克風的上限（毫秒）：WebView2 跳權限詢問沒人按時會一直等 */
export const MIC_TIMEOUT_MS = 8000;
/** 峰值到這裡算削峰 */
export const CLIP_PEAK = 0.99;

/** getUserMedia 的錯誤（或 "timeout"）要不要改用 Windows 錄音機 */
export function shouldFallback(errorName: string, engine: "desktop" | "web"): boolean {
  return engine === "desktop" && ["NotReadableError", "NotAllowedError", "timeout"].includes(errorName);
}

/** 所有聲道樣本的絕對值最大 */
export function peakOf(channels: Float32Array[]): number {
  let peak = 0;
  for (const ch of channels) for (const v of ch) peak = Math.max(peak, Math.abs(v));
  return peak;
}

/** 錄好的一段：WAV 位元組、長度（秒）、峰值 */
export interface Take {
  wav: Uint8Array;
  seconds: number;
  peak: number;
}

/** 進行中的錄音 */
export interface MicSession {
  /** 停止並回傳錄好的一段 */
  stop(): Promise<Take>;
  /** 放棄 */
  cancel(): void;
}

/** 開麥克風（8 秒逾時）；失敗丟出 DOMException 或名稱為 "timeout" 的錯誤 */
async function openMic(): Promise<MediaStream> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error("The microphone didn't respond"), { name: "timeout" })), MIC_TIMEOUT_MS);
  });
  try {
    return await Promise.race([navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** 錄好的壓縮音訊 → 48 kHz 單聲道 WAV＋長度與峰值 */
export async function toTake(blob: Blob): Promise<Take> {
  const ctx = new OfflineAudioContext(1, 1, SYNTH_RATE);
  const buffer = await ctx.decodeAudioData(await blob.arrayBuffer());
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const mono = new Float32Array(buffer.length);
  for (const ch of channels) for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / channels.length;
  // 解碼的取樣率就是 SYNTH_RATE（OfflineAudioContext 會重新取樣）
  return { wav: synthToWav(mono), seconds: buffer.duration, peak: peakOf(channels) };
}

/** 開始用麥克風錄音；拿不到麥克風丟錯（呼叫端用 shouldFallback 決定要不要改用錄音機） */
export async function startMic(): Promise<MicSession> {
  const stream = await openMic();
  const recorder = new MediaRecorder(stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  recorder.start();
  const release = () => stream.getTracks().forEach((t) => t.stop());
  return {
    stop: () => new Promise<Take>((resolve, reject) => {
      recorder.onstop = () => {
        release();
        toTake(new Blob(chunks, { type: recorder.mimeType })).then(resolve, reject);
      };
      recorder.stop();
    }),
    cancel: () => {
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
}
