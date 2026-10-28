import { describe, expect, it } from "vitest";
import {
  MAX_MUSIC_SECONDS, chordMidi, envPoints, musicFrames, musicGroups, musicSeconds, parseChord, soundGroups, validateMusic, validateSound,
  type MusicSpec, type SoundSpec,
} from "./spec";
import { MUSIC_EXAMPLES, SOUND_TEMPLATES } from "./templates";
import cases from "./validationCases.json";

/** 一個最小的合法音效 */
const BEEP: SoundSpec = { length: 0.5, voices: [{ source: { type: "osc", wave: "sine", freq: 880 }, env: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.1 } }] };

/** 一個最小的合法配樂：一小節、一個墊音 */
const PAD: MusicSpec = {
  bpm: 120, bars: 2, chords: ["Am", "F"],
  parts: [{ role: "pad", voice: { source: { type: "osc", wave: "triangle" }, env: { attack: 0.1, decay: 0, sustain: 1, release: 0.3 } }, notes: [{ at: 0, len: 4, chord: 0 }] }],
};

/** 驗證後的錯誤訊息（合格回空字串） */
const soundErr = (v: unknown) => { const r = validateSound(v); return r.ok ? "" : r.errors.join("\n"); };
const musicErr = (v: unknown) => { const r = validateMusic(v); return r.ok ? "" : r.errors.join("\n"); };

describe("內建範本", () => {
  it("8～10 個音效範本，都通過驗證，涵蓋常用的種類", () => {
    expect(SOUND_TEMPLATES.length).toBeGreaterThanOrEqual(8);
    expect(SOUND_TEMPLATES.length).toBeLessThanOrEqual(10);
    for (const t of SOUND_TEMPLATES) expect(soundErr(t.spec), t.id).toBe("");
    const ids = SOUND_TEMPLATES.map((t) => t.id);
    for (const id of ["whoosh", "pop", "ding", "typing", "rise", "fall", "click", "sweep"]) expect(ids).toContain(id);
  });

  it("配樂範例都通過驗證", () => {
    expect(MUSIC_EXAMPLES.length).toBeGreaterThan(0);
    for (const t of MUSIC_EXAMPLES) expect(musicErr(t.spec), t.id).toBe("");
  });
});

describe("validateSound", () => {
  it("合格的回傳清理過的 spec（丟掉多餘欄位）", () => {
    const r = validateSound({ ...BEEP, title: "beep" });
    expect(r.ok).toBe(true);
    if (r.ok) expect("title" in r.spec).toBe(false);
  });

  it("結構錯誤（JSON Schema）", () => {
    expect(soundErr({ voices: BEEP.voices })).toContain("length");
    expect(soundErr({ ...BEEP, length: 20 })).toContain("length 要在 0.05～10 之間");
    expect(soundErr({ ...BEEP, voices: [{ ...BEEP.voices[0], source: { type: "osc", wave: "pulse", freq: 440 } }] })).toContain("wave");
  });

  it("曲線的 t 要嚴格遞增", () => {
    const v = { ...BEEP.voices[0], source: { type: "osc" as const, wave: "sine" as const, freq: [{ t: 0, v: 200 }, { t: 0.3, v: 800 }, { t: 0.2, v: 400 }] } };
    expect(soundErr({ ...BEEP, voices: [v] })).toContain("voices[0].source.freq 的 t 要嚴格遞增");
  });

  it("聲部要在總長度內開始；振盪器要有頻率", () => {
    expect(soundErr({ ...BEEP, voices: [{ ...BEEP.voices[0], start: 0.5 }] })).toContain("voices[0].start");
    expect(soundErr({ ...BEEP, voices: [{ ...BEEP.voices[0], source: { type: "osc", wave: "sine" } }] })).toContain("voices[0].source.freq");
  });
});

describe("validateMusic", () => {
  it("合格", () => {
    expect(musicErr(PAD)).toBe("");
  });

  it("非鼓聲部要有 voice；音符要有音高；鼓的音符要有 drum", () => {
    expect(musicErr({ ...PAD, parts: [{ role: "bass", notes: [{ at: 0, len: 1, pitch: 40 }] }] })).toContain("parts[0].voice");
    expect(musicErr({ ...PAD, parts: [{ ...PAD.parts[0], notes: [{ at: 0, len: 1 }] }] })).toContain("parts[0].notes[0]");
    expect(musicErr({ ...PAD, parts: [{ role: "drums", notes: [{ at: 0, len: 1, pitch: 40 }] }] })).toContain("drum");
  });

  it("音符要落在 loopBars 內；loopBars 不能超過 bars", () => {
    expect(musicErr({ ...PAD, parts: [{ ...PAD.parts[0], loopBars: 1, notes: [{ at: 4, len: 1, chord: 0 }] }] })).toContain("parts[0].notes[0].at");
    expect(musicErr({ ...PAD, parts: [{ ...PAD.parts[0], loopBars: 4 }] })).toContain("loopBars");
  });

  it("太長不行", () => {
    expect(musicErr({ ...PAD, bpm: 60, bars: 32 })).toContain(`${MAX_MUSIC_SECONDS}`);
  });
});

describe("配樂長度＝整數小節", () => {
  it("秒數與取樣數", () => {
    expect(musicSeconds({ ...PAD, bpm: 120, bars: 2 })).toBe(4);
    expect(musicSeconds({ ...PAD, bpm: 100, beatsPerBar: 3, bars: 5 })).toBeCloseTo(9, 9);
    expect(musicFrames({ ...PAD, bpm: 100, beatsPerBar: 3, bars: 5 }, 48000)).toBe(432000);
    // 每小節不是整數個樣本時取最接近的
    expect(musicFrames({ ...PAD, bpm: 110, bars: 1 }, 48000)).toBe(Math.round((4 * 60 / 110) * 48000));
  });
});

describe("和弦與音高", () => {
  it("和弦名稱 → 根音與音程", () => {
    expect(parseChord("Am")).toEqual({ root: 9, intervals: [0, 3, 7, 12] });
    expect(parseChord("Bbmaj7")).toEqual({ root: 10, intervals: [0, 4, 7, 11] });
    expect(parseChord("F#7")).toEqual({ root: 6, intervals: [0, 4, 7, 10] });
    expect(parseChord("C")).toEqual({ root: 0, intervals: [0, 4, 7, 12] });
  });

  it("和弦的第幾個音 → MIDI（octave 4 的 C 是 60）", () => {
    expect(chordMidi("C", 0, 4)).toBe(60);
    expect(chordMidi("Am", 1, 4)).toBe(72);
    expect(chordMidi("G7", 3, 2)).toBe(53);
  });
});

describe("envPoints（ADSR → 折線）", () => {
  it("按住比 attack＋decay 長：上升、衰減到 sustain、保持、釋放", () => {
    expect(envPoints({ attack: 0.1, decay: 0.2, sustain: 0.5, release: 0.3 }, 1, 0.8)).toEqual([
      [0, 0], [0.1, 0.8], [0.30000000000000004, 0.4], [1, 0.4], [1.3, 0],
    ]);
  });

  it("按住比 attack 短：放開時從當下的值開始釋放", () => {
    const pts = envPoints({ attack: 0.2, decay: 0.2, sustain: 0.5, release: 0.1 }, 0.1, 1);
    expect(pts[pts.length - 2][0]).toBeCloseTo(0.1);
    expect(pts[pts.length - 2][1]).toBeCloseTo(0.5);
    expect(pts[pts.length - 1]).toEqual([0.2, 0]);
  });
});

describe("展開成要發聲的音", () => {
  it("音效：repeat 展開、dur 預設到總長度減 release", () => {
    const groups = soundGroups({ ...BEEP, length: 1, voices: [{ ...BEEP.voices[0], start: 0.1, repeat: { count: 3, every: 0.2 } }] });
    expect(groups).toHaveLength(1);
    expect(groups[0].hits.map((h) => h.t)).toEqual([0.1, 0.30000000000000004, 0.5]);
    expect(groups[0].hits[0].gate).toBeCloseTo(0.8);
  });

  it("配樂：loopBars 重複、和弦依小節循環", () => {
    const spec: MusicSpec = { ...PAD, bars: 4, chords: ["C", "G"], parts: [{ ...PAD.parts[0], loopBars: 1, notes: [{ at: 0, len: 1, chord: 0, octave: 3 }] }] };
    const [g] = musicGroups(spec);
    // 每小節 2 秒，四個小節各一個音；C3、G3、C3、G3
    expect(g.hits.map((h) => h.t)).toEqual([0, 2, 4, 6]);
    expect(g.hits.map((h) => h.midi)).toEqual([48, 55, 48, 55]);
    expect(g.hits[0].gate).toBe(0.5);
  });

  it("配樂：鼓聲部依鼓種分組（內建音色）", () => {
    const spec: MusicSpec = { ...PAD, bars: 1, parts: [{ role: "drums", notes: [{ at: 0, len: 0.5, drum: "kick" }, { at: 1, len: 0.5, drum: "snare" }, { at: 2, len: 0.5, drum: "kick" }] }] };
    const groups = musicGroups(spec);
    expect(groups.map((g) => [g.label, g.hits.length])).toEqual([["drums:kick", 2], ["drums:snare", 1]]);
  });
});

describe("共用的驗證案例（validationCases.json；閘道的 SynthParserTest 跑同一份，兩邊的規則要一致）", () => {
  for (const c of cases as { name: string; kind: "sound" | "music"; spec: unknown; error: string | null }[]) {
    it(c.name, () => {
      const err = c.kind === "sound" ? soundErr(c.spec) : musicErr(c.spec);
      if (c.error === null) expect(err).toBe("");
      else expect(err).toContain(c.error);
    });
  }
});

describe("am 欄位（隨機振幅調變）", () => {
  it("rate 1～200、depth 0～1 才收", () => {
    const base = { length: 0.3, voices: [{ source: { type: "noise", color: "white" }, env: { attack: 0.01, decay: 0.1, sustain: 0, release: 0.05 } }] };
    const withAm = (am: unknown) => ({ ...base, voices: [{ ...base.voices[0], am }] });
    const ok = validateSound(withAm({ rate: 60, depth: 0.7 }));
    expect(ok.ok && (ok.spec.voices[0] as { am?: unknown }).am).toEqual({ rate: 60, depth: 0.7 });
    expect(validateSound(withAm({ rate: 60, depth: 1.5 })).ok).toBe(false);
    expect(validateSound(withAm({ rate: 0, depth: 0.5 })).ok).toBe(false);
  });
});
