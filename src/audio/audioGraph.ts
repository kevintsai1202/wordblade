// 預覽的 Web Audio 混音（§5.13）：每個音訊片段的 <audio> → MediaElementAudioSourceNode → 片段增益 → 軌道匯流排 → 總輸出。
// 片段增益＝audioPlan 的 gain（片段音量×軌道音量×淡入淡出）；匯流排增益只做配樂壓低（ducking 曲線）。
//
// 注意（原專案 2026-10-20 在 WebView2 遇過整條靜音）：
// - AudioContext 要在使用者手勢裡建立並 resume()，所以由播放鍵、Space 等手勢呼叫 ensureAudioGraph()。
// - MediaElementAudioSourceNode 讀跨來源的媒體會輸出靜音，除非元素設了 crossOrigin 且回應有 CORS 標頭。
//   Tauri 的頁面是 http://tauri.localhost、素材是 http://asset.localhost（跨來源）；asset 協定會回
//   Access-Control-Allow-Origin，所以 <audio> 一律設 crossOrigin="anonymous"（在設 src 之前）。
// - createMediaElementSource 接上就拆不掉，元素一旦接進來就一直走這張圖。

/** 增益變化的時間常數（秒）：避免直接跳值產生爆音 */
const RAMP = 0.02;

/** 預覽的混音圖 */
export class AudioGraph {
  readonly ctx: AudioContext;
  private readonly master: GainNode;
  /** 量總輸出音量用（診斷與 WebView2 靜音檢查） */
  private readonly analyser: AnalyserNode;
  private readonly buses = new Map<string, GainNode>();
  /** 已接進圖的元素：clipId → 元素與它的片段增益 */
  private readonly voices = new Map<string, { el: HTMLMediaElement; gain: GainNode }>();

  constructor() {
    this.ctx = new AudioContext();
    this.master = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
  }

  /** 取得（必要時建立）軌道匯流排 */
  private bus(trackId: string): GainNode {
    let bus = this.buses.get(trackId);
    if (!bus) {
      bus = this.ctx.createGain();
      bus.connect(this.master);
      this.buses.set(trackId, bus);
    }
    return bus;
  }

  /** 把片段的元素接進圖（同一個元素只接一次）；元素的 volume 固定 1，音量改由增益節點控制 */
  connect(clipId: string, el: HTMLMediaElement, trackId: string) {
    if (this.voices.get(clipId)?.el === el) return;
    const gain = this.ctx.createGain();
    this.ctx.createMediaElementSource(el).connect(gain);
    gain.connect(this.bus(trackId));
    el.volume = 1;
    this.voices.set(clipId, { el, gain });
  }

  /** 片段已經接進圖了嗎 */
  has(clipId: string): boolean {
    return this.voices.has(clipId);
  }

  /** 設定片段增益 */
  setClipGain(clipId: string, gain: number) {
    this.voices.get(clipId)?.gain.gain.setTargetAtTime(gain, this.ctx.currentTime, RAMP);
  }

  /** 設定軌道匯流排增益（配樂壓低） */
  setBusGain(trackId: string, gain: number) {
    this.bus(trackId).gain.setTargetAtTime(gain, this.ctx.currentTime, RAMP);
  }

  /** 片段刪掉時拆掉它的增益節點（元素本身已經被釋放） */
  drop(clipId: string) {
    this.voices.get(clipId)?.gain.disconnect();
    this.voices.delete(clipId);
  }

  /** 總輸出目前的 RMS（0～1） */
  level(): number {
    const data = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    return Math.sqrt(sum / data.length);
  }
}

/** 整個程式共用一張圖（第一次在使用者手勢裡建立） */
let graph: AudioGraph | null = null;

/** 診斷用：e2e 與 WebView2 的靜音檢查從 window 讀混音圖的狀態與總輸出音量 */
declare global {
  interface Window {
    __wordbladeAudio?: () => { state: AudioContextState; level: number } | null;
  }
}
window.__wordbladeAudio = () => (graph ? { state: graph.ctx.state, level: graph.level() } : null);

/** 在使用者手勢裡呼叫：建立混音圖並 resume；瀏覽器不支援 Web Audio 時回 null（預覽退回 el.volume） */
export function ensureAudioGraph(): AudioGraph | null {
  if (!graph && typeof AudioContext !== "undefined") graph = new AudioGraph();
  if (graph && graph.ctx.state !== "running") void graph.ctx.resume();
  return graph;
}

/** 目前的混音圖（還沒建立回 null） */
export function currentAudioGraph(): AudioGraph | null {
  return graph;
}
