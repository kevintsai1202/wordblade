// 宣告式音效與配樂的 spec（§5.15、D27）：型別、驗證（JSON Schema＋schema 表達不了的語意檢查）、展開成要發聲的音。
// 純函式，不碰 Web Audio；真正算成聲音在 render.ts。模型只回這種 JSON，不寫程式。
import schemaJson from "./synth.schema.json";
import { checkSchema, type JsonSchema } from "./schemaLite";

/** 共用的 schema（閘道有一份複本，scripts/synth/build-prompt.mjs 同步） */
export const SYNTH_SCHEMA = schemaJson as unknown as JsonSchema;

/** 配樂最長幾秒（bars × beatsPerBar × 60 ÷ bpm） */
export const MAX_MUSIC_SECONDS = 120;
/** 一份配樂展開後最多幾個音（防止算圖太久） */
export const MAX_MUSIC_HITS = 3000;

/** 曲線：固定值，或 {t, v} 點（t 秒、嚴格遞增，點之間指數過渡） */
export type Curve = number | { t: number; v: number }[];

/** 振盪器來源 */
export interface OscSource {
  type: "osc";
  wave: "sine" | "square" | "sawtooth" | "triangle";
  /** 頻率（Hz）；配樂由音符決定音高，可省略 */
  freq?: Curve;
  /** 音分 */
  detune?: number;
}

/** 雜訊來源 */
export interface NoiseSource {
  type: "noise";
  color: "white" | "pink";
}

/** 濾波器 */
export interface Filter {
  type: "lowpass" | "highpass" | "bandpass" | "notch";
  cutoff: Curve;
  q?: number;
}

/** 振幅包絡（秒；sustain 是 0～1 的比例） */
export interface Env {
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

/** 選用效果 */
export interface Effects {
  delay?: { time: number; feedback: number; mix: number };
  reverb?: { decay: number; mix: number };
  distortion?: { amount: number };
}

/** 音色：來源 → 濾波器 → 包絡 → 效果 */
export interface Voice {
  source: OscSource | NoiseSource;
  filter?: Filter;
  env: Env;
  gain?: number;
  effects?: Effects;
}

/** 音效的一個聲部：音色＋開始時間、按住多久、重複 */
export interface SoundEvent extends Voice {
  start?: number;
  dur?: number;
  repeat?: { count: number; every: number };
}

/** 音效 spec */
export interface SoundSpec {
  length: number;
  gain?: number;
  seed?: number;
  voices: SoundEvent[];
}

/** 鼓的種類 */
export type Drum = "kick" | "snare" | "hat" | "openhat" | "clap";

/** 配樂的一個音符（at、len 以拍為單位，從聲部音符表的開頭算） */
export interface Note {
  at: number;
  len: number;
  pitch?: number;
  chord?: number;
  octave?: number;
  drum?: Drum;
  vel?: number;
}

/** 配樂的一個聲部 */
export interface Part {
  role: "bass" | "pad" | "arp" | "lead" | "drums";
  voice?: Voice;
  gain?: number;
  loopBars?: number;
  notes: Note[];
}

/** 配樂 spec */
export interface MusicSpec {
  bpm: number;
  beatsPerBar?: 2 | 3 | 4;
  bars: number;
  chords: string[];
  gain?: number;
  seed?: number;
  parts: Part[];
}

/** 驗證結果 */
export type Validated<S> = { ok: true; spec: S } | { ok: false; errors: string[] };

/** 曲線的 t 要嚴格遞增 */
function checkCurve(curve: Curve | undefined, path: string, errors: string[]) {
  if (!Array.isArray(curve)) return;
  for (let i = 1; i < curve.length; i++) {
    if (curve[i].t <= curve[i - 1].t) {
      errors.push(`${path} 的 t 要嚴格遞增`);
      return;
    }
  }
}

/** 音色的語意檢查（曲線遞增） */
function checkVoice(v: Voice, path: string, errors: string[]) {
  if (v.source.type === "osc") checkCurve(v.source.freq, `${path}.source.freq`, errors);
  if (v.filter) checkCurve(v.filter.cutoff, `${path}.filter.cutoff`, errors);
}

/** 驗證音效 spec：先過 schema（丟掉多餘欄位），再查聲部開始時間、振盪器頻率、曲線遞增 */
export function validateSound(raw: unknown): Validated<SoundSpec> {
  const r = checkSchema(SYNTH_SCHEMA, "#/$defs/sound", raw);
  if (r.errors.length) return { ok: false, errors: r.errors };
  const spec = r.value as SoundSpec;
  const errors: string[] = [];
  spec.voices.forEach((v, i) => {
    const path = `voices[${i}]`;
    if ((v.start ?? 0) >= spec.length) errors.push(`${path}.start（${v.start} 秒）要小於總長度 ${spec.length} 秒`);
    if (v.source.type === "osc" && v.source.freq === undefined) errors.push(`${path}.source.freq：音效的振盪器要有頻率`);
    checkVoice(v, path, errors);
  });
  return errors.length ? { ok: false, errors } : { ok: true, spec };
}

/** 每小節幾拍（預設 4） */
export function beatsPerBar(spec: MusicSpec): number {
  return spec.beatsPerBar ?? 4;
}

/** 配樂長度（秒）：整數小節 */
export function musicSeconds(spec: MusicSpec): number {
  return (spec.bars * beatsPerBar(spec) * 60) / spec.bpm;
}

/** 配樂的樣本數（取最接近的整數；循環時每圈長度一樣） */
export function musicFrames(spec: MusicSpec, rate: number): number {
  return Math.round(musicSeconds(spec) * rate);
}

/** 驗證配樂 spec：schema 之外查聲部要有音色、音符要有音高、音符落在 loopBars 內、總長度與總音數上限 */
export function validateMusic(raw: unknown): Validated<MusicSpec> {
  const r = checkSchema(SYNTH_SCHEMA, "#/$defs/music", raw);
  if (r.errors.length) return { ok: false, errors: r.errors };
  const spec = r.value as MusicSpec;
  const errors: string[] = [];
  const bpb = beatsPerBar(spec);
  const seconds = musicSeconds(spec);
  if (seconds > MAX_MUSIC_SECONDS) errors.push(`配樂長度 ${seconds.toFixed(1)} 秒超過 ${MAX_MUSIC_SECONDS} 秒；減少 bars 或加快 bpm`);
  spec.parts.forEach((p, i) => {
    const path = `parts[${i}]`;
    const loopBars = p.loopBars ?? spec.bars;
    if (loopBars > spec.bars) errors.push(`${path}.loopBars（${loopBars}）不能超過 bars（${spec.bars}）`);
    if (p.role !== "drums") {
      if (!p.voice) errors.push(`${path}.voice：drums 以外的聲部要有 voice`);
      else checkVoice(p.voice, `${path}.voice`, errors);
    }
    p.notes.forEach((n, j) => {
      const np = `${path}.notes[${j}]`;
      if (p.role === "drums" && !n.drum) errors.push(`${np}：鼓聲部的音符要有 drum`);
      if (p.role !== "drums" && n.pitch === undefined && n.chord === undefined) errors.push(`${np}：要有 pitch 或 chord`);
      if (n.at >= loopBars * bpb) errors.push(`${np}.at（${n.at}）要小於 ${loopBars * bpb} 拍（loopBars × beatsPerBar）`);
    });
  });
  if (!errors.length) {
    const hits = musicGroups(spec).reduce((n, g) => n + g.hits.length, 0);
    if (hits > MAX_MUSIC_HITS) errors.push(`展開後有 ${hits} 個音，超過 ${MAX_MUSIC_HITS} 個；減少音符或小節數`);
  }
  return errors.length ? { ok: false, errors } : { ok: true, spec };
}

/** 音名 → 半音（C＝0） */
const PITCH_CLASS: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
/** 和弦性質 → 四個和弦音的音程（第四個是七音，沒有七音的用高八度根音） */
const QUALITY: Record<string, number[]> = {
  "": [0, 4, 7, 12], m: [0, 3, 7, 12], "7": [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10], dim: [0, 3, 6, 9], sus2: [0, 2, 7, 12], sus4: [0, 5, 7, 12],
};

/** 解析和弦名稱（Am、Bbmaj7、F#7…）；格式由 schema 的 pattern 保證 */
export function parseChord(name: string): { root: number; intervals: number[] } {
  const m = /^([A-G])(#|b)?(.*)$/.exec(name);
  if (!m || !(m[3] in QUALITY)) throw new Error(`和弦格式不對：${name}`);
  const root = (PITCH_CLASS[m[1]] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0) + 12) % 12;
  return { root, intervals: QUALITY[m[3]] };
}

/** 和弦的第 index 個音在 octave 的 MIDI 編號（octave 4 的 C＝60） */
export function chordMidi(chord: string, index: number, octave: number): number {
  const { root, intervals } = parseChord(chord);
  return 12 * (octave + 1) + root + intervals[index];
}

/** MIDI → Hz（A4＝69＝440 Hz） */
export function midiToHz(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** 包絡時間的下限（秒）：避免同一時間點有兩個值 */
const MIN_SEGMENT = 0.001;

/**
 * ADSR → 折線點 [時間（相對於音的開頭）, 增益]。gate 是按住多久，之後 release 回到 0。
 * 按住的時間比 attack＋decay 短時，從放開那一刻的值開始釋放（不會跳）。
 */
export function envPoints(env: Env, gate: number, vel: number): [number, number][] {
  const a = Math.max(MIN_SEGMENT, env.attack);
  const d = Math.max(MIN_SEGMENT, env.decay);
  const r = Math.max(MIN_SEGMENT, env.release);
  const s = env.sustain * vel;
  const g = Math.max(MIN_SEGMENT, gate);
  if (g < a) return [[0, 0], [g, (vel * g) / a], [g + r, 0]];
  if (g < a + d) return [[0, 0], [a, vel], [g, vel + ((s - vel) * (g - a)) / d], [g + r, 0]];
  return [[0, 0], [a, vel], [a + d, s], [g, s], [g + r, 0]];
}

/** 一個要發聲的音：t 是絕對時間（秒） */
export interface Hit {
  t: number;
  /** 按住多久（秒） */
  gate: number;
  /** 力度 0～1 */
  vel: number;
  /** 配樂音符的音高（有的話蓋過音色的 freq） */
  midi?: number;
}

/** 同一個音色、同一組效果的一群音（算圖時共用一條效果鏈） */
export interface Group {
  /** 除錯用的名字（voices[0]、bass、drums:kick…） */
  label: string;
  voice: Voice;
  gain: number;
  hits: Hit[];
}

/** 音效 → 每個聲部一群音（repeat 展開；dur 預設到總長度減 release） */
export function soundGroups(spec: SoundSpec): Group[] {
  return spec.voices.map((v, i) => {
    const start = v.start ?? 0;
    const gate = v.dur ?? Math.max(MIN_SEGMENT, spec.length - start - v.env.release);
    const count = v.repeat?.count ?? 1;
    const every = v.repeat?.every ?? 0;
    const hits: Hit[] = [];
    for (let k = 0; k < count; k++) {
      const t = start + k * every;
      if (t < spec.length) hits.push({ t, gate, vel: 1 });
    }
    const { source, filter, env, effects } = v;
    return { label: `voices[${i}]`, voice: { source, filter, env, effects }, gain: v.gain ?? 1, hits };
  });
}

/** 內建鼓組的音色（鼓聲部不用 voice） */
export const DRUM_VOICES: Record<Drum, Voice> = {
  kick: { source: { type: "osc", wave: "sine", freq: [{ t: 0, v: 150 }, { t: 0.12, v: 45 }] }, env: { attack: 0.001, decay: 0.3, sustain: 0, release: 0.05 } },
  snare: { source: { type: "noise", color: "white" }, filter: { type: "bandpass", cutoff: 1800, q: 0.8 }, env: { attack: 0.001, decay: 0.15, sustain: 0, release: 0.05 } },
  hat: { source: { type: "noise", color: "white" }, filter: { type: "highpass", cutoff: 7000 }, env: { attack: 0.001, decay: 0.04, sustain: 0, release: 0.02 } },
  openhat: { source: { type: "noise", color: "white" }, filter: { type: "highpass", cutoff: 6000 }, env: { attack: 0.001, decay: 0.25, sustain: 0, release: 0.1 } },
  clap: { source: { type: "noise", color: "pink" }, filter: { type: "bandpass", cutoff: 1200, q: 1.2 }, env: { attack: 0.001, decay: 0.12, sustain: 0, release: 0.05 } },
};

/** 各角色沒寫 octave 時的預設八度 */
const DEFAULT_OCTAVE: Record<Part["role"], number> = { bass: 2, pad: 4, arp: 4, lead: 5, drums: 4 };

/**
 * 配樂 → 一群群的音：每個聲部一群（鼓聲部依鼓種分群），音符表每 loopBars 小節重複到整首結束；
 * 用 chord 的音依「音符開始的那一小節」的和弦算音高（和弦清單不夠長就從頭循環）。
 */
export function musicGroups(spec: MusicSpec): Group[] {
  const bpb = beatsPerBar(spec);
  const sec = 60 / spec.bpm;
  const totalBeats = spec.bars * bpb;
  const groups: Group[] = [];
  for (const part of spec.parts) {
    const loopBeats = (part.loopBars ?? spec.bars) * bpb;
    const reps = Math.ceil(totalBeats / loopBeats);
    const byDrum = new Map<Drum, Group>();
    const pitched: Group | null = part.role === "drums" ? null : { label: part.role, voice: part.voice!, gain: part.gain ?? 1, hits: [] };
    if (pitched) groups.push(pitched);
    for (let r = 0; r < reps; r++) {
      for (const n of part.notes) {
        const beat = r * loopBeats + n.at;
        if (beat >= totalBeats) continue;
        const hit: Hit = { t: beat * sec, gate: n.len * sec, vel: n.vel ?? 0.8 };
        if (pitched) {
          const chord = spec.chords[Math.floor(beat / bpb) % spec.chords.length];
          hit.midi = n.pitch ?? chordMidi(chord, n.chord ?? 0, n.octave ?? DEFAULT_OCTAVE[part.role]);
          pitched.hits.push(hit);
        } else if (n.drum) {
          let g = byDrum.get(n.drum);
          if (!g) {
            g = { label: `drums:${n.drum}`, voice: DRUM_VOICES[n.drum], gain: part.gain ?? 1, hits: [] };
            byDrum.set(n.drum, g);
            groups.push(g);
          }
          g.hits.push(hit);
        }
      }
    }
  }
  return groups;
}
