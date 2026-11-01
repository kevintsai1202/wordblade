// 匯出的聲音（spec §5.4）：每 5 分鐘一段離線混音，只解那一段用到的來源音訊，依序送進編碼器（不把整支片的聲音放進記憶體）。
// 片段音量×軌道音量×淡入淡出，配樂軌再乘壓低曲線（和預覽同一條，§5.13）；變速片段用 soundtouchjs（WSOLA）保持音高。
// 純函式（voicesIn、resampleLinear、stretch、mixSpan）由 Vitest 測；mixAudio 負責讀檔（mediabunny）與送編碼器。
import type { AudioSampleSource, Input } from "mediabunny";
import { SoundTouch } from "soundtouchjs";
import { gainAt, type DuckCurve } from "../audio/ducking";
import { fadeFactor } from "../compositor/framePlan";
import type { Media, Project, Seconds } from "../core/model";
import { clipEnd, timelineToSource } from "../core/timeline";

/** 輸出取樣率 */
export const SAMPLE_RATE = 48000;
/** 每段混音的長度（秒） */
export const CHUNK_SECONDS = 300;
/** 送進編碼器的每塊長度（秒） */
const PIECE_SECONDS = 1;

/** 一個音訊片段落在某段時間內的部分 */
export interface VoiceSpan {
  clipId: string;
  mediaId: string;
  /** 時間軸範圍 [from, to) */
  from: Seconds;
  to: Seconds;
  /** from 對應的素材時間 */
  srcFrom: Seconds;
  speed: number;
  /** 在配樂軌（要乘壓低曲線） */
  music: boolean;
}

/** 和時間軸 [a, b) 重疊的音訊片段（未靜音的音軌） */
export function voicesIn(project: Project, a: Seconds, b: Seconds): VoiceSpan[] {
  const tracks = new Map(project.tracks.filter((t) => t.kind === "audio" && !t.muted).map((t) => [t.id, t]));
  const out: VoiceSpan[] = [];
  for (const clip of project.clips) {
    const track = tracks.get(clip.trackId);
    if (!track) continue;
    const from = Math.max(a, clip.start);
    const to = Math.min(b, clipEnd(clip));
    if (to <= from) continue;
    out.push({ clipId: clip.id, mediaId: clip.mediaId, from, to, srcFrom: timelineToSource(clip, from), speed: clip.speed, music: track.role === "music" });
  }
  return out;
}

/** 線性內插重新取樣成 outLength 個樣本（同取樣率且長度相同時原樣回傳） */
export function resampleLinear(input: Float32Array, inRate: number, outLength: number, outRate = SAMPLE_RATE): Float32Array {
  if (inRate === outRate && outLength === input.length) return input;
  const out = new Float32Array(outLength);
  const step = inRate / outRate;
  const last = input.length - 1;
  for (let i = 0; i < outLength; i++) {
    const x = i * step;
    const k = Math.floor(x);
    if (k >= last) {
      out[i] = last >= 0 ? input[last] : 0;
      continue;
    }
    const f = x - k;
    out[i] = input[k] * (1 - f) + input[k + 1] * f;
  }
  return out;
}

/**
 * 變速且保持音高（WSOLA，soundtouchjs）：speed 2 是兩倍快（長度減半）。輸出補齊或截成 outLength。
 * soundtouch 內部會留一段尾巴，後面補一段靜音把它推出來。
 */
export function stretch(channels: [Float32Array, Float32Array], speed: number, outLength: number): [Float32Array, Float32Array] {
  const [l, r] = channels;
  const n = l.length;
  const pad = 16384;
  const interleaved = new Float32Array((n + pad) * 2);
  for (let i = 0; i < n; i++) {
    interleaved[2 * i] = l[i];
    interleaved[2 * i + 1] = r[i];
  }
  const st = new SoundTouch();
  st.tempo = speed;
  st.inputBuffer.putSamples(interleaved, 0, n + pad);
  st.process();
  const got = Math.min(st.outputBuffer.frameCount, outLength);
  const buf = new Float32Array(got * 2);
  st.outputBuffer.receiveSamples(buf, got);
  const left = new Float32Array(outLength);
  const right = new Float32Array(outLength);
  for (let i = 0; i < got; i++) {
    left[i] = buf[2 * i];
    right[i] = buf[2 * i + 1];
  }
  return [left, right];
}

/**
 * 把一個片段的聲音（已是輸出取樣率、從 span.from 開始、長度涵蓋 span）乘上增益疊進輸出區塊。
 * out 從時間軸 chunkStart 開始；增益＝片段音量×軌道音量×淡入淡出（×配樂壓低）。
 */
export function mixSpan(out: [Float32Array, Float32Array], chunkStart: Seconds, rate: number, project: Project, span: VoiceSpan, pcm: [Float32Array, Float32Array], duck: DuckCurve | null) {
  const clip = project.clips.find((c) => c.id === span.clipId)!;
  const track = project.tracks.find((t) => t.id === clip.trackId)!;
  const base = clip.volume * track.volume;
  const offset = Math.round((span.from - chunkStart) * rate);
  const count = Math.min(pcm[0].length, Math.round((span.to - span.from) * rate), out[0].length - offset);
  for (let k = 0; k < count; k++) {
    const t = span.from + k / rate;
    let g = base * fadeFactor(clip, t);
    if (span.music && duck) g *= gainAt(duck, t);
    out[0][offset + k] += pcm[0][k] * g;
    out[1][offset + k] += pcm[1][k] * g;
  }
}

/** 時間軸 t 秒開始的一段額外聲音（特效音效；已是輸出取樣率、雙聲道） */
export interface ExtraSound {
  t: Seconds;
  channels: [Float32Array, Float32Array];
}

/** 把額外聲音疊進從時間軸 chunkStart 開始的輸出區塊（只疊區塊裡的那段） */
export function mixExtra(out: [Float32Array, Float32Array], chunkStart: Seconds, rate: number, extra: ExtraSound) {
  const offset = Math.round((extra.t - chunkStart) * rate);
  const from = Math.max(0, -offset);
  const to = Math.min(extra.channels[0].length, out[0].length - offset);
  for (let k = from; k < to; k++) {
    out[0][offset + k] += extra.channels[0][k];
    out[1][offset + k] += extra.channels[1][k];
  }
}

/** 混音需要的東西 */
export interface MixJob {
  project: Project;
  /** 成片長度 */
  duration: Seconds;
  source: (media: Media) => Promise<Blob | string>;
  audioSource: AudioSampleSource;
  /** 配樂壓低曲線（沒有就不壓） */
  duck?: DuckCurve | null;
  /** 額外的聲音（2D 特效的音效） */
  extras?: ExtraSound[];
  signal: AbortSignal;
}

/** 讀素材 [s0, s1) 的聲音，轉成雙聲道（單聲道複製兩份）、來源取樣率 */
async function readSource(mb: typeof import("mediabunny"), input: Input, s0: Seconds, s1: Seconds): Promise<{ channels: [Float32Array, Float32Array]; rate: number } | null> {
  const track = await input.getPrimaryAudioTrack();
  if (!track) return null;
  const rate = await track.getSampleRate();
  const total = Math.max(0, Math.round((s1 - s0) * rate));
  const left = new Float32Array(total);
  const right = new Float32Array(total);
  for await (const sample of new mb.AudioSampleSink(track).samples(s0, s1)) {
    const frames = sample.numberOfFrames;
    const start = Math.round((sample.timestamp - s0) * rate);
    const tmp = new Float32Array(frames);
    for (let ch = 0; ch < 2; ch++) {
      const src = Math.min(ch, sample.numberOfChannels - 1);
      sample.copyTo(tmp, { planeIndex: src, format: "f32-planar" });
      const dst = ch === 0 ? left : right;
      // 樣本可能從 s0 之前開始：只取落在範圍內的部分
      for (let i = Math.max(0, -start); i < frames && start + i < total; i++) dst[start + i] = tmp[i];
    }
    sample.close();
  }
  return { channels: [left, right], rate };
}

/** 分段混音並送進編碼器 */
export async function mixAudio(job: MixJob): Promise<void> {
  const mb = await import("mediabunny");
  const { project, duration, audioSource, signal } = job;
  const inputs = new Map<string, Input>();
  try {
    for (let c0 = 0; c0 < duration; c0 += CHUNK_SECONDS) {
      if (signal.aborted) return;
      const c1 = Math.min(duration, c0 + CHUNK_SECONDS);
      const length = Math.round((c1 - c0) * SAMPLE_RATE);
      const out: [Float32Array, Float32Array] = [new Float32Array(length), new Float32Array(length)];
      for (const span of voicesIn(project, c0, c1)) {
        const media = project.media.find((m) => m.id === span.mediaId);
        if (!media || media.offline || media.kind === "image" || media.audio === false) continue;
        let input = inputs.get(media.id);
        if (!input) {
          const src = await job.source(media);
          input = new mb.Input({ source: typeof src === "string" ? new mb.UrlSource(src) : new mb.BlobSource(src), formats: mb.ALL_FORMATS });
          inputs.set(media.id, input);
        }
        const srcLen = (span.to - span.from) * span.speed;
        const read = await readSource(mb, input, span.srcFrom, span.srcFrom + srcLen);
        if (!read) continue;
        const outLen = Math.round((span.to - span.from) * SAMPLE_RATE);
        // 先換成輸出取樣率（素材長度不變），變速再用 WSOLA 伸縮
        const atRate = Math.round(srcLen * SAMPLE_RATE);
        let pcm: [Float32Array, Float32Array] = [resampleLinear(read.channels[0], read.rate, atRate), resampleLinear(read.channels[1], read.rate, atRate)];
        if (span.speed !== 1) pcm = stretch(pcm, span.speed, outLen);
        mixSpan(out, c0, SAMPLE_RATE, project, span, pcm, job.duck ?? null);
      }
      for (const extra of job.extras ?? []) mixExtra(out, c0, SAMPLE_RATE, extra);
      // 超過 ±1 的削掉（多軌疊加可能超過）
      for (const ch of out) for (let i = 0; i < ch.length; i++) ch[i] = Math.max(-1, Math.min(1, ch[i]));
      // 每秒一塊送進編碼器（AudioSample 是 planar：左聲道接右聲道）
      const piece = PIECE_SECONDS * SAMPLE_RATE;
      for (let p = 0; p < length; p += piece) {
        if (signal.aborted) return;
        const n = Math.min(piece, length - p);
        const data = new Float32Array(n * 2);
        data.set(out[0].subarray(p, p + n), 0);
        data.set(out[1].subarray(p, p + n), n);
        const sample = new mb.AudioSample({ data, format: "f32-planar", numberOfChannels: 2, sampleRate: SAMPLE_RATE, timestamp: c0 + p / SAMPLE_RATE });
        await audioSource.add(sample);
        sample.close();
      }
    }
    audioSource.close();
  } finally {
    for (const input of inputs.values()) input.dispose();
  }
}
