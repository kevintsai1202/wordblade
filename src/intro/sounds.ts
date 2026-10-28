// 翻頁式片頭的聲音（spec §5.23、調查 docs/research/intro-styles.md §1.6、§3.4）：全部是宣告式 spec（§5.15），用合成器算成 WAV，
// 不用外部素材。翻頁照 brand-v2 的 make_flip_sfx.py 改寫成三個雜訊聲部（揮動、沙沙＋隨機振幅調變、落下的「啪」），
// 做慢（0.32 秒）與快（0.12 秒）兩版；上升音蓋住翻頁段；揭曉時一記重擊。擺位與音量都從 flipIntro 的 cue 表來。
import type { MusicSpec, SoundEvent, SoundSpec } from "../audio/synth/spec";
import type { FlipPlan } from "./flip";

/** 音效種類 */
export type IntroSoundKey = "flipSlow" | "flipFast" | "riser" | "impact";

/** 間隔小於這個秒數的頁用快版（brand-v2 實測：再快就連成一片沙沙聲） */
const FAST_GAP = 0.13;

/** 一聲翻頁（len 秒）：揮動、沙沙（隨機振幅調變）、在 62% 處落下的「啪」 */
function flipSound(len: number): SoundSpec {
  const swish: SoundEvent = {
    source: { type: "noise", color: "white" }, filter: { type: "bandpass", cutoff: 4200, q: 0.6 },
    env: { attack: len * 0.5, decay: len * 0.4, sustain: 0, release: 0.01 }, gain: 0.55, dur: len * 0.9,
  };
  const rustle: SoundEvent = {
    source: { type: "noise", color: "white" }, filter: { type: "bandpass", cutoff: 2700, q: 0.56 },
    env: { attack: len * 0.43, decay: len * 0.5, sustain: 0, release: 0.01 }, gain: 0.4, dur: len * 0.93,
    am: { rate: 65, depth: 0.85 },
  };
  const drop: SoundEvent = {
    source: { type: "noise", color: "white" }, filter: { type: "bandpass", cutoff: 590, q: 0.53 },
    env: { attack: 0.002, decay: 0.05, sustain: 0, release: 0.01 }, gain: 0.9, start: len * 0.62, dur: 0.002,
  };
  return { length: len, gain: 0.8, seed: 20261018, voices: [swish, rustle, drop] };
}

/** 上升音（len 秒）：白雜訊 highpass 300 Hz → 6 kHz，越來越大聲；加一條往上滑的正弦 */
function riserSound(len: number): SoundSpec {
  return {
    length: len, gain: 0.7, seed: 7,
    voices: [
      {
        source: { type: "noise", color: "white" }, filter: { type: "highpass", cutoff: [{ t: 0, v: 300 }, { t: len, v: 6000 }], q: 0.7 },
        env: { attack: len * 0.92, decay: 0.05, sustain: 0, release: 0.05 }, gain: 0.6,
      },
      {
        source: { type: "osc", wave: "sawtooth", freq: [{ t: 0, v: 110 }, { t: len, v: 880 }] }, filter: { type: "lowpass", cutoff: 1800 },
        env: { attack: len * 0.92, decay: 0.05, sustain: 0, release: 0.05 }, gain: 0.18,
      },
    ],
  };
}

/** 重擊：60→35 Hz 下滑的正弦（長衰減、殘響）＋短雜訊爆發 */
const IMPACT: SoundSpec = {
  length: 1.6, gain: 0.85, seed: 3,
  voices: [
    {
      source: { type: "osc", wave: "sine", freq: [{ t: 0, v: 60 }, { t: 0.5, v: 35 }] },
      env: { attack: 0.005, decay: 1.2, sustain: 0, release: 0.2 }, gain: 1, effects: { reverb: { decay: 1.4, mix: 0.25 } },
    },
    {
      source: { type: "noise", color: "pink" }, filter: { type: "lowpass", cutoff: 2200 },
      env: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.05 }, gain: 0.6, dur: 0.01, effects: { reverb: { decay: 1.2, mix: 0.3 } },
    },
  ],
};

/** 這支片頭要用的音效 spec（上升音的長度隨片頭時間） */
export function introSoundSpecs(plan: FlipPlan): Record<IntroSoundKey, SoundSpec> {
  const riserStart = plan.cues.find((c) => c.kind === "riserStart")?.t ?? 0;
  const climax = plan.cues.find((c) => c.kind === "titleIn")?.t ?? plan.reveal - 0.5;
  return { flipSlow: flipSound(0.32), flipFast: flipSound(0.12), riser: riserSound(Math.max(0.3, climax - riserStart + 0.2)), impact: IMPACT };
}

/** 一個音效擺位（相對片頭開頭） */
export interface IntroSoundCue {
  key: IntroSoundKey;
  t: number;
  volume: number;
}

/** 音效擺位：每頁一聲（快段用快版、音量再 ×0.6，避免糊成一片）、上升音、揭曉重擊 */
export function introSoundCues(plan: FlipPlan): IntroSoundCue[] {
  const pages = plan.cues.filter((c) => c.kind === "page");
  const cues: IntroSoundCue[] = pages.map((p, i) => {
    const gap = (pages[i + 1]?.t ?? plan.reveal - 0.5) - p.t;
    const fast = gap < FAST_GAP;
    return { key: fast ? "flipFast" : "flipSlow", t: p.t, volume: Math.round((p.strength ?? 1) * (fast ? 0.6 : 1) * 1000) / 1000 };
  });
  const riser = plan.cues.find((c) => c.kind === "riserStart");
  if (riser) cues.push({ key: "riser", t: riser.t, volume: 0.8 });
  cues.push({ key: "impact", t: plan.reveal, volume: 1 });
  return cues;
}

/** 內建配樂的揭曉時間：120 BPM 4/4，第 3 小節第一拍（鼓組與貝斯進場） */
export const INTRO_MUSIC_REVEAL = 4;

/**
 * 內建配樂：120 BPM、4 小節（8 秒）。前 2 小節只有墊音（漸強）與往上走的琶音，第 2 小節後半 hi-hat 加密鋪陳，
 * 第 3 小節第一拍（4 秒）鼓組、拍手與貝斯同時進＝揭曉。
 */
export const INTRO_MUSIC: MusicSpec = {
  bpm: 120, beatsPerBar: 4, bars: 4, chords: ["Am", "F", "C", "G"], gain: 0.8, seed: 11,
  parts: [
    {
      role: "pad", gain: 0.35,
      voice: { source: { type: "osc", wave: "sawtooth" }, filter: { type: "lowpass", cutoff: 1400 }, env: { attack: 0.6, decay: 0.4, sustain: 0.8, release: 0.6 }, effects: { reverb: { decay: 2, mix: 0.3 } } },
      notes: [0, 4, 8, 12].flatMap((at, bar) => [0, 1, 2].map((chord) => ({ at, len: 4, chord, octave: 4, vel: bar < 2 ? 0.35 + bar * 0.15 : 0.7 }))),
    },
    {
      role: "arp", gain: 0.4,
      voice: { source: { type: "osc", wave: "square" }, filter: { type: "lowpass", cutoff: 2600 }, env: { attack: 0.005, decay: 0.15, sustain: 0.2, release: 0.1 }, effects: { delay: { time: 0.375, feedback: 0.3, mix: 0.2 } } },
      // 前 2 小節八分音符往上走（和弦音輪流、第 2 小節高八度），越來越大聲
      notes: Array.from({ length: 16 }, (_, i) => ({ at: i * 0.5, len: 0.4, chord: i % 3, octave: i < 8 ? 4 : 5, vel: Math.round((0.3 + (0.6 * i) / 15) * 100) / 100 })),
    },
    {
      role: "bass", gain: 0.7,
      voice: { source: { type: "osc", wave: "triangle" }, filter: { type: "lowpass", cutoff: 700 }, env: { attack: 0.01, decay: 0.3, sustain: 0.6, release: 0.15 } },
      notes: [8, 10, 12, 14].map((at) => ({ at, len: 1.8, chord: 0, octave: 2 })),
    },
    {
      role: "drums", gain: 0.85,
      notes: [
        // 第 2 小節後半：hi-hat 十六分音符鋪陳
        ...Array.from({ length: 8 }, (_, i) => ({ at: 6 + i * 0.25, len: 0.2, drum: "hat" as const, vel: Math.round((0.25 + i * 0.07) * 100) / 100 })),
        // 第 3 小節起：每拍大鼓、二四拍小鼓、八分 hi-hat；揭曉那一拍加拍手
        { at: 8, len: 0.5, drum: "clap" as const, vel: 1 },
        ...[8, 9, 10, 11, 12, 13, 14, 15].map((at) => ({ at, len: 0.5, drum: "kick" as const, vel: at === 8 ? 1 : 0.85 })),
        ...[9, 11, 13, 15].map((at) => ({ at, len: 0.5, drum: "snare" as const, vel: 0.7 })),
        ...Array.from({ length: 16 }, (_, i) => ({ at: 8 + i * 0.5, len: 0.25, drum: "hat" as const, vel: 0.35 })),
      ],
    },
  ],
};
