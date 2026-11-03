// 配樂壓低（§5.13、§5.4）：看對白軌（role＝dialogue）的音量包絡，有人講話時把配樂軌（role＝music）壓低。
// 純函式算出整條時間軸的增益曲線；預覽每格查這條曲線設配樂匯流排的增益，匯出的 OfflineAudioContext 也用同一條。
import type { Project, Seconds } from "../core/model";
import { clipEnd, timelineToSource } from "../core/timeline";
import { envelopeAt, type Envelope } from "./envelope";

/** 壓低的參數 */
export interface DuckOptions {
  /** 對白音量超過這個 RMS 就算在講話（0.02 約 -34 dBFS） */
  threshold: number;
  /** 講話時配樂的增益（0.3 約 -10.5 dB） */
  depth: number;
  /** 壓下去的時間常數（秒） */
  attack: Seconds;
  /** 回復的時間常數（秒） */
  release: Seconds;
  /** 講完後再撐多久才開始回復（秒），避免字與字之間忽大忽小 */
  hold: Seconds;
  /** 曲線每秒幾個點 */
  rate: number;
}

export const DEFAULT_DUCK: DuckOptions = { threshold: 0.02, depth: 0.3, attack: 0.08, release: 0.6, hold: 0.3, rate: 100 };

/** 增益曲線（時間軸時間，從 0 開始） */
export interface DuckCurve {
  rate: number;
  gain: Float32Array;
}

/** 時間軸時間 t 的增益；超出曲線範圍回 1 */
export function gainAt(curve: DuckCurve, t: Seconds): number {
  const i = Math.floor(t * curve.rate);
  return i >= 0 && i < curve.gain.length ? curve.gain[i] : 1;
}

/**
 * 算出配樂的增益曲線：
 * 1. 每個時間點取「所有對白片段在那一刻的包絡 × 片段音量 × 軌道音量」的最大值；
 * 2. 超過門檻算講話，講完再撐 hold 秒；
 * 3. 目標增益講話時是 depth、否則 1，用一階平滑（壓下用 attack、回復用 release）。
 * envelopes 沒有的素材當成沒聲音。
 */
export function duckingCurve(project: Project, envelopes: Map<string, Envelope>, options: Partial<DuckOptions> = {}): DuckCurve {
  const o = { ...DEFAULT_DUCK, ...options };
  // 對白軌與 AI 重配音軌都算「有人講話」；重配音切回原聲時 AI 片段靜音，不算（2026-11-02）
  const dialogue = new Map(project.tracks.filter((t) => t.kind === "audio" && (t.role === "dialogue" || t.role === "voice") && !t.muted).map((t) => [t.id, t]));
  const inactive = new Set((project.voiceovers ?? []).filter((v) => !v.active).map((v) => v.clipId));
  const clips = project.clips.filter((c) => dialogue.has(c.trackId) && envelopes.has(c.mediaId) && !inactive.has(c.id));
  const end = project.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
  const n = Math.ceil(end * o.rate);
  const gain = new Float32Array(n);
  const dt = 1 / o.rate;
  const down = 1 - Math.exp(-dt / o.attack);
  const up = 1 - Math.exp(-dt / o.release);
  let g = 1;
  let lastSpeech = -Infinity;
  for (let i = 0; i < n; i++) {
    const t = i * dt;
    let level = 0;
    for (const clip of clips) {
      if (t < clip.start || t >= clipEnd(clip)) continue;
      const v = envelopeAt(envelopes.get(clip.mediaId)!, timelineToSource(clip, t)) * clip.volume * dialogue.get(clip.trackId)!.volume;
      if (v > level) level = v;
    }
    if (level > o.threshold) lastSpeech = t;
    const target = t - lastSpeech <= o.hold ? o.depth : 1;
    g += (target - g) * (target < g ? down : up);
    // 回到 1 附近就直接當 1，沒人講話的段落是精確的 1
    gain[i] = target === 1 && 1 - g < 1e-4 ? (g = 1) : g;
  }
  return { rate: o.rate, gain };
}
