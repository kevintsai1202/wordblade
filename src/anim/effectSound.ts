// 2D 特效的音效（spec §5.15、§5.7；開發者 2026-11-01 選定「跟著特效走」）：
// 範本的音效存在特效參數 sounds（元件雜湊＋參數＋at），音量是 soundGain（0～1，0＝關掉，沒有＝1）。
// 音效元件是沙盒裡的程式，事件由沙盒算（soundClips，只回資料）；這裡把事件排進 OfflineAudioContext 算成聲音，
// 預覽轉成 WAV 網址當一個跟著特效的聲音播放，匯出直接混進音軌。排程照搬原專案 anim_runtime 的 scheduleSound（同一套事件與種子）。
import type { Effect } from "../core/model";

/** 音效事件（沙盒 makeAudio 產生的格式） */
export interface SoundEvent {
  kind: "tone" | "noise";
  at: number;
  dur: number;
  attack: number;
  release: number;
  gain: number;
  pan: number;
  wave?: OscillatorType;
  freq?: number;
  freqEnd?: number;
  color?: "white" | "pink";
  filter?: { type: BiquadFilterType; freq: number; freqEnd: number; q: number } | null;
}

/** 一段音效（沙盒 soundClips 的結果）：at 是相對特效起點的秒數 */
export interface SoundClip {
  index: number;
  at: number;
  seconds: number;
  events: SoundEvent[];
  seed: number;
}

/** 算好的特效音效：從特效起點開始的雙聲道聲音、預覽用的 WAV 網址 */
export interface EffectSound {
  buffer: AudioBuffer;
  url: string;
}

/** 音效取樣率（和匯出混音一樣） */
export const SOUND_RATE = 48000;

/** 特效的音效音量（0～1；沒設＝1） */
export function soundGain(effect: Effect): number {
  const g = effect.params.soundGain;
  return typeof g === "number" && Number.isFinite(g) ? Math.min(1, Math.max(0, g)) : 1;
}

/** 特效有沒有要出聲的音效（2D、有 sounds、音量不是 0） */
export function hasSound(effect: Effect): boolean {
  return effect.kind === "anim2d" && Array.isArray(effect.params.sounds) && (effect.params.sounds as unknown[]).length > 0 && soundGain(effect) > 0;
}

/** 快取鍵：音效、長度、音量、id（種子由 id 決定）一樣就是同一段聲音 */
export function soundKey(effect: Effect): string {
  return JSON.stringify([effect.id, effect.end - effect.start, effect.params.sounds, soundGain(effect)]);
}

/** 決定性亂數（mulberry32，同原專案 seeded） */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 把一段音效的事件排進 AudioContext（從 offset 秒起）；照搬原專案 scheduleSound */
function schedule(ac: BaseAudioContext, destination: AudioNode, events: SoundEvent[], offset: number, seed: number) {
  for (const [i, ev] of events.entries()) {
    const t0 = offset + ev.at;
    const t1 = t0 + ev.dur;
    const attack = Math.max(0.001, ev.attack);
    const release = Math.max(0.001, ev.release);
    const peakEnd = Math.max(t0 + attack, t1 - release);
    const gain = ac.createGain();
    gain.gain.setValueAtTime(0, t0);
    gain.gain.linearRampToValueAtTime(ev.gain, t0 + attack);
    gain.gain.setValueAtTime(ev.gain, peakEnd);
    gain.gain.linearRampToValueAtTime(0, Math.max(peakEnd + 0.001, t1));
    const pan = ac.createStereoPanner();
    pan.pan.value = ev.pan;
    gain.connect(pan);
    pan.connect(destination);
    let source: AudioScheduledSourceNode;
    if (ev.kind === "tone") {
      const osc = ac.createOscillator();
      osc.type = ev.wave ?? "sine";
      osc.frequency.setValueAtTime(ev.freq ?? 440, t0);
      if (ev.freqEnd !== undefined && ev.freqEnd !== ev.freq) osc.frequency.exponentialRampToValueAtTime(ev.freqEnd, t1);
      osc.connect(gain);
      source = osc;
    } else {
      const n = Math.max(1, Math.ceil(ev.dur * ac.sampleRate));
      const buf = ac.createBuffer(1, n, ac.sampleRate);
      const data = buf.getChannelData(0);
      const rnd = seeded(seed * 7919 + i);
      let b0 = 0, b1 = 0, b2 = 0;
      for (let k = 0; k < n; k++) {
        const w = rnd() * 2 - 1;
        if (ev.color === "pink") {
          b0 = 0.99765 * b0 + w * 0.099046;
          b1 = 0.963 * b1 + w * 0.2965164;
          b2 = 0.57 * b2 + w * 1.0526913;
          data[k] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
        } else data[k] = w;
      }
      const src = ac.createBufferSource();
      src.buffer = buf;
      if (ev.filter) {
        const f = ac.createBiquadFilter();
        f.type = ev.filter.type;
        f.Q.value = ev.filter.q;
        f.frequency.setValueAtTime(ev.filter.freq, t0);
        if (ev.filter.freqEnd !== ev.filter.freq) f.frequency.exponentialRampToValueAtTime(ev.filter.freqEnd, t1);
        src.connect(f);
        f.connect(gain);
      } else src.connect(gain);
      source = src;
    }
    source.start(t0);
    source.stop(t1 + 0.01);
  }
}

/**
 * 一個特效的全部音效 → 從特效起點開始的雙聲道聲音（乘上音量）；沒有聲音回 null。
 * 長度至少是特效長度：預覽的 <audio> 在特效範圍內一直同步，聲音比特效短的話播完會被當成「暫停」再 play()，從頭重播。
 */
export async function renderSound(clips: SoundClip[], gain: number, duration = 0): Promise<AudioBuffer | null> {
  if (!clips.length || gain <= 0) return null;
  const seconds = Math.max(duration, Math.max(...clips.map((c) => c.at + c.seconds)) + 0.05);
  const ac = new OfflineAudioContext(2, Math.ceil(seconds * SOUND_RATE), SOUND_RATE);
  const master = ac.createGain();
  master.gain.value = gain;
  master.connect(ac.destination);
  for (const c of clips) schedule(ac, master, c.events, c.at, c.seed);
  return ac.startRendering();
}

/** AudioBuffer → 16-bit PCM WAV（預覽的 <audio> 用） */
export function wavBlob(buffer: AudioBuffer): Blob {
  const ch = buffer.numberOfChannels;
  const n = buffer.length;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, "RIFF"); out.setUint32(4, 36 + n * ch * 2, true); str(8, "WAVE"); str(12, "fmt ");
  out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true); out.setUint32(24, buffer.sampleRate, true);
  out.setUint32(28, buffer.sampleRate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  str(36, "data"); out.setUint32(40, n * ch * 2, true);
  const chans = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c));
  for (let i = 0, o = 44; i < n; i++) for (let c = 0; c < ch; c++, o += 2) out.setInt16(o, Math.max(-1, Math.min(1, chans[c][i])) * 0x7fff, true);
  return new Blob([out.buffer], { type: "audio/wav" });
}
