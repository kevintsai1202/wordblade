// 宣告式音訊的解讀器（§5.15、D27）：把驗證過的 spec 建成 Web Audio 節點，用 OfflineAudioContext 算成單聲道樣本，再編成 WAV。
// 不執行模型寫的任何程式；spec 只是資料。雜訊與殘響的脈衝響應用固定種子的亂數，同一份 spec 每次算出來都一樣。
// 配樂：多算一段尾巴（release、延遲、殘響），再把尾巴疊回開頭，長度剛好是整數小節、首尾無縫循環。
import { encodeWav } from "../../asr/wav";
import {
  envPoints, midiToHz, musicFrames, musicGroups, soundGroups,
  type Curve, type Group, type MusicSpec, type SoundSpec,
} from "./spec";

/** 輸出取樣率（和匯出的 SAMPLE_RATE 一致） */
export const SYNTH_RATE = 48000;
/** 正規化的上限：峰值超過就整體縮小（16-bit 編碼會夾住超過 1 的值） */
const PEAK_LIMIT = 0.89;
/** 音效結尾的淡出（秒），避免截斷時喀一聲 */
const END_FADE = 0.005;
/** 配樂尾巴最長幾秒（超過的部分很小聲，不算） */
const MAX_TAIL = 10;
/** 預設總音量 */
const DEFAULT_GAIN = 0.8;

/** 建立 OfflineAudioContext（瀏覽器用內建的；Vitest 傳 node-web-audio-api 的） */
export type ContextFactory = (channels: number, length: number, rate: number) => OfflineAudioContext;

/** 預設工廠：瀏覽器的 OfflineAudioContext */
const browserFactory: ContextFactory = (channels, length, rate) => new OfflineAudioContext(channels, length, rate);

/** 固定種子的亂數（mulberry32），回傳 0～1 */
function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 2 秒的雜訊（白或粉紅；粉紅用 Paul Kellet 的濾波近似），循環播放 */
function noiseBuffer(ctx: BaseAudioContext, color: "white" | "pink", random: () => number): AudioBuffer {
  const buffer = ctx.createBuffer(1, 2 * ctx.sampleRate, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < data.length; i++) {
    const white = random() * 2 - 1;
    if (color === "white") {
      data[i] = white * 0.5;
      continue;
    }
    b0 = 0.99886 * b0 + white * 0.0555179;
    b1 = 0.99332 * b1 + white * 0.0750759;
    b2 = 0.969 * b2 + white * 0.153852;
    b3 = 0.8665 * b3 + white * 0.3104856;
    b4 = 0.55 * b4 + white * 0.5329522;
    b5 = -0.7616 * b5 - white * 0.016898;
    data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
    b6 = white * 0.115926;
  }
  return buffer;
}

/** 殘響的脈衝響應：雜訊乘上指數衰減，decay 秒後降到 −60 dB */
function impulseResponse(ctx: BaseAudioContext, decay: number, random: () => number): AudioBuffer {
  const length = Math.max(1, Math.round(decay * ctx.sampleRate));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (random() * 2 - 1) * Math.exp((-6.9 * i) / length);
  return buffer;
}

/** 失真曲線（軟削波）：amount 0～1 */
function distortionCurve(amount: number): Float32Array<ArrayBuffer> {
  const k = amount * 50;
  const curve = new Float32Array(1024);
  for (let i = 0; i < curve.length; i++) {
    const x = (i / (curve.length - 1)) * 2 - 1;
    curve[i] = ((1 + k) * x) / (1 + k * Math.abs(x));
  }
  return curve;
}

/** 把曲線排到 AudioParam 上：t0 是這個音的開頭；點之間指數過渡（頻率與截止頻率都是正數） */
function applyCurve(param: AudioParam, curve: Curve, t0: number) {
  if (typeof curve === "number") {
    param.setValueAtTime(curve, t0);
    return;
  }
  param.setValueAtTime(curve[0].v, t0);
  if (curve[0].t > 0) param.setValueAtTime(curve[0].v, t0 + curve[0].t);
  for (let i = 1; i < curve.length; i++) param.exponentialRampToValueAtTime(curve[i].v, t0 + curve[i].t);
}

/** 一群音共用的效果鏈：匯流排增益 →（失真）→ 乾聲＋延遲＋殘響 → 總輸出；回傳匯流排（音接到這裡） */
function groupBus(ctx: BaseAudioContext, group: Group, master: AudioNode, random: () => number): GainNode {
  const bus = ctx.createGain();
  bus.gain.value = group.gain * (group.voice.gain ?? 1);
  const fx = group.voice.effects ?? {};
  let out: AudioNode = bus;
  if (fx.distortion && fx.distortion.amount > 0) {
    const shaper = ctx.createWaveShaper();
    shaper.curve = distortionCurve(fx.distortion.amount);
    out.connect(shaper);
    out = shaper;
  }
  out.connect(master);
  if (fx.delay && fx.delay.mix > 0) {
    // 延遲：回授迴圈（DelayNode 在迴圈裡，Web Audio 允許）
    const delay = ctx.createDelay(1);
    delay.delayTime.value = fx.delay.time;
    const feedback = ctx.createGain();
    feedback.gain.value = fx.delay.feedback;
    const wet = ctx.createGain();
    wet.gain.value = fx.delay.mix;
    out.connect(delay);
    delay.connect(feedback);
    feedback.connect(delay);
    delay.connect(wet);
    wet.connect(master);
  }
  if (fx.reverb && fx.reverb.mix > 0) {
    const convolver = ctx.createConvolver();
    convolver.buffer = impulseResponse(ctx, fx.reverb.decay, random);
    const wet = ctx.createGain();
    wet.gain.value = fx.reverb.mix;
    out.connect(convolver);
    convolver.connect(wet);
    wet.connect(master);
  }
  return bus;
}

/** 把一群音排進 context：每個音是 來源 →（濾波器）→ 包絡增益 → 匯流排 */
function scheduleGroup(ctx: BaseAudioContext, group: Group, master: AudioNode, random: () => number, noise: Map<string, AudioBuffer>) {
  const bus = groupBus(ctx, group, master, random);
  const { source, filter, env } = group.voice;
  for (const hit of group.hits) {
    const end = hit.t + hit.gate + Math.max(0.001, env.release) + 0.01;
    let src: AudioScheduledSourceNode;
    if (source.type === "osc") {
      const osc = ctx.createOscillator();
      osc.type = source.wave;
      if (hit.midi !== undefined) osc.frequency.setValueAtTime(midiToHz(hit.midi), hit.t);
      else applyCurve(osc.frequency, source.freq ?? 440, hit.t);
      if (source.detune) osc.detune.setValueAtTime(source.detune, hit.t);
      osc.start(hit.t);
      src = osc;
    } else {
      // 雜訊：共用一段循環的雜訊，每個音從不同位置開始（位置也用固定種子）
      let buffer = noise.get(source.color);
      if (!buffer) {
        buffer = noiseBuffer(ctx, source.color, random);
        noise.set(source.color, buffer);
      }
      const player = ctx.createBufferSource();
      player.buffer = buffer;
      player.loop = true;
      player.start(hit.t, random() * 1.9);
      src = player;
    }
    let node: AudioNode = src;
    if (filter) {
      const biquad = ctx.createBiquadFilter();
      biquad.type = filter.type;
      biquad.Q.value = filter.q ?? 1;
      applyCurve(biquad.frequency, filter.cutoff, hit.t);
      node.connect(biquad);
      node = biquad;
    }
    const amp = ctx.createGain();
    const points = envPoints(env, hit.gate, hit.vel);
    amp.gain.setValueAtTime(0, hit.t);
    for (const [t, v] of points.slice(1)) amp.gain.linearRampToValueAtTime(v, hit.t + t);
    node.connect(amp);
    amp.connect(bus);
    src.stop(end);
  }
}

/** 把一組群音算成單聲道樣本（frames 個） */
async function renderGroups(groups: Group[], frames: number, gain: number, seed: number, factory: ContextFactory): Promise<Float32Array> {
  const ctx = factory(1, Math.max(1, frames), SYNTH_RATE);
  const master = ctx.createGain();
  master.gain.value = gain;
  master.connect(ctx.destination);
  const random = seededRandom(seed);
  const noise = new Map<string, AudioBuffer>();
  for (const g of groups) scheduleGroup(ctx, g, master, random, noise);
  const rendered = await ctx.startRendering();
  return new Float32Array(rendered.getChannelData(0));
}

/** 峰值超過上限就整體縮小（不放大：小聲的 spec 維持小聲） */
function limitPeak(x: Float32Array): Float32Array {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  if (peak > PEAK_LIMIT) {
    const k = PEAK_LIMIT / peak;
    for (let i = 0; i < x.length; i++) x[i] *= k;
  }
  return x;
}

/** 音效 → 樣本：長度剛好 length 秒，結尾 5 毫秒淡出 */
export async function renderSound(spec: SoundSpec, factory: ContextFactory = browserFactory): Promise<Float32Array> {
  const frames = Math.round(spec.length * SYNTH_RATE);
  const x = await renderGroups(soundGroups(spec), frames, spec.gain ?? DEFAULT_GAIN, spec.seed ?? 1, factory);
  const fade = Math.min(x.length, Math.round(END_FADE * SYNTH_RATE));
  for (let i = 0; i < fade; i++) x[x.length - 1 - i] *= i / fade;
  return limitPeak(x);
}

/** 一群音在結尾之後還會響多久（release、按住超過結尾、延遲與殘響的尾巴） */
function tailSeconds(groups: Group[], loopSeconds: number): number {
  let tail = 0;
  for (const g of groups) {
    const fx = g.voice.effects ?? {};
    // 延遲回授衰減到 −60 dB 要幾次：log(0.001) / log(feedback)
    const delayTail = fx.delay && fx.delay.feedback > 0 ? fx.delay.time * Math.min(20, Math.log(0.001) / Math.log(fx.delay.feedback)) : fx.delay ? fx.delay.time : 0;
    const fxTail = delayTail + (fx.reverb?.decay ?? 0);
    for (const h of g.hits) tail = Math.max(tail, h.t + h.gate + g.voice.env.release - loopSeconds + fxTail);
  }
  return Math.min(MAX_TAIL, Math.max(0, tail));
}

/** 配樂 → 樣本：長度剛好整數小節；結尾之後的尾巴疊回開頭（循環播放時上一圈的餘音就在那裡），首尾無縫 */
export async function renderMusic(spec: MusicSpec, factory: ContextFactory = browserFactory): Promise<Float32Array> {
  const loop = musicFrames(spec, SYNTH_RATE);
  const groups = musicGroups(spec);
  const tail = Math.ceil(tailSeconds(groups, loop / SYNTH_RATE) * SYNTH_RATE);
  const x = await renderGroups(groups, loop + tail, spec.gain ?? DEFAULT_GAIN, spec.seed ?? 1, factory);
  const out = new Float32Array(loop);
  for (let i = 0; i < x.length; i++) out[i % loop] += x[i];
  return limitPeak(out);
}

/** 樣本 → 48 kHz 單聲道 16-bit WAV（素材庫匯入用） */
export function synthToWav(samples: Float32Array): Uint8Array {
  return encodeWav(samples, SYNTH_RATE);
}
