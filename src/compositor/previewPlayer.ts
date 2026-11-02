// 預覽播放器（§5.13）：依 framePlan／audioPlan 讓每個片段的 <video>／<img>／<audio> 對準時間，再交給合成器畫。
// 影像元素一律靜音，聲音由 A 軌片段各自的 <audio> 發出：Web Audio 混音圖建立後（第一次按播放）走 AudioGraph，
// 片段增益＋配樂匯流排壓低；還沒建立或瀏覽器不支援時退回直接設 el.volume。
import { offlineCard } from "./offlineCard";
import { MaskLayer } from "../sam/maskLayer";
import type { ThumbStore } from "../media/thumbStore";
import type { EffectRenderer } from "../anim/effectRenderer";
import { currentAudioGraph } from "../audio/audioGraph";
import { gainAt, type DuckCurve } from "../audio/ducking";
import type { Media, Project, Seconds } from "../core/model";
import { audioPlan, type VideoLayer } from "./framePlan";
import { layerPlan } from "./layerPlan";
import { GlCompositor } from "./glCompositor";
import { CaptionLayer } from "../captions/captionLayer";
import { DEFAULT_CAPTION_STYLE } from "../captions/captionLayout";
import type { Caption, TimelineWord } from "../core/captions";

/** 播放中，元素時間和該有的素材時間差超過這個值（秒）才重新對齊，避免一直跳 */
const PLAY_DRIFT: Seconds = 0.15;

/** 圖層的框、透明度與色彩（併進下層狀態：轉場推移、淡化或調色改了，讀下層畫面的特效才會重畫） */
function layerLook(layer: VideoLayer): string {
  const r = layer.rect;
  const g = layer.grade;
  return `:${r.x.toFixed(3)},${layer.opacity.toFixed(3)}${g ? `:g${g.brightness},${g.contrast},${g.saturation},${g.temperature}` : ""}`;
}
/** 暫停時差超過這個值（秒）就把元素拖到正確位置 */
const SEEK_EPSILON: Seconds = 1 / 60;

/** 預覽播放器 */
export class PreviewPlayer {
  private readonly compositor: GlCompositor;
  /** 每個影像片段一個 <video>（同一支素材在畫面上出現兩次時要兩個元素） */
  private readonly videos = new Map<string, HTMLVideoElement>();
  /** 每個圖片片段一個 <img> */
  private readonly images = new Map<string, HTMLImageElement>();
  /** 每個音訊片段一個 <audio> */
  private readonly audios = new Map<string, HTMLAudioElement>();
  private project: Project | null = null;
  /** 配樂壓低曲線（沒有就不壓） */
  private duck: DuckCurve | null = null;
  /** 2D 特效畫格（沙盒）；沒有就不畫特效 */
  private effects: EffectRenderer | null = null;
  /** 特效的格率 */
  private fps = 30;
  /** 字幕（燒進畫面的那一層，§5.4、D37）與它要的詞時間 */
  private captions: Caption[] = [];
  private captionWords: TimelineWord[] = [];
  private readonly captionLayer: CaptionLayer;
  /** 縮圖序列（D39）：暫停中影片還在跳轉時，先畫最近的縮圖 */
  private thumbs: ThumbStore | null = null;
  /** 每個影片元素最後一次畫好的畫面在素材的哪個時間（跳轉中 currentTime 已經是目標，要另外記） */
  private readonly shown = new WeakMap<HTMLVideoElement, number>();
  /** SAM 遮罩（和匯出共用畫法） */
  private readonly masks = new MaskLayer();
  /** 用縮圖代替影片畫面的次數（e2e 讀 canvas 的 data-thumb-frames） */
  private thumbFrames = 0;

  /**
   * @param canvas 預覽畫布
   * @param mediaUrl 素材 → 網址（Engine.mediaUrl；代理檔做好後會變）
   * @param onFrameReady 暫停時元素拖動完成、有新畫面可畫時呼叫（讓外面重畫）
   */
  constructor(private readonly canvas: HTMLCanvasElement, private readonly mediaUrl: (media: Media) => string, private readonly onFrameReady: () => void) {
    this.compositor = new GlCompositor(canvas);
    // 字型（中文分塊）載好時重畫目前這一格
    this.captionLayer = new CaptionLayer(canvas.width, canvas.height, onFrameReady);
  }

  /** 換字幕（專案的詞或斷點變了就重算後交進來） */
  setCaptions(captions: Caption[], words: TimelineWord[]) {
    this.captions = captions;
    this.captionWords = words;
  }

  /** 換專案（編輯後）；不在專案裡的片段元素釋放掉 */
  setProject(project: Project) {
    this.project = project;
    const ids = new Set(project.clips.map((c) => c.id));
    for (const map of [this.videos, this.images, this.audios] as Map<string, HTMLElement>[]) {
      for (const [id, el] of map) {
        if (ids.has(id)) continue;
        if (el instanceof HTMLMediaElement) el.pause();
        el.removeAttribute("src");
        map.delete(id);
        if (map === this.audios) currentAudioGraph()?.drop(id);
      }
    }
  }

  /** 接上縮圖序列 */
  setThumbs(store: ThumbStore | null) {
    this.thumbs = store;
  }

  /** 2D 特效的音效（特效 id → WAV 網址；跟著特效走） */
  private fxSounds = new Map<string, string>();
  /** 特效音效的元素（特效 id → 元素） */
  private readonly fxAudios = new Map<string, HTMLAudioElement>();

  /** 設定特效音效（特效 id → WAV 網址）；不再用到的元素停掉 */
  setEffectSounds(sounds: Map<string, string>) {
    this.fxSounds = sounds;
    this.canvas.dataset.fxSounds = String(sounds.size);
    for (const [id, el] of this.fxAudios) {
      if (sounds.get(id) === el.dataset.src) continue;
      el.pause();
      currentAudioGraph()?.drop(`fx:${id}`);
      this.fxAudios.delete(id);
    }
  }

  /** 接上 2D 特效（沙盒畫格）與格率 */
  setEffectRenderer(renderer: EffectRenderer | null, fps: number) {
    this.effects = renderer;
    this.fps = fps;
  }

  /** 設定配樂壓低曲線（音量包絡或專案變了就重算） */
  setDuckCurve(curve: DuckCurve | null) {
    this.duck = curve;
  }

  /** 取得（必要時建立）某個片段的元素；素材網址變了（代理檔做好）就換 src */
  private element<T extends HTMLVideoElement | HTMLAudioElement | HTMLImageElement>(map: Map<string, T>, clipId: string, mediaId: string, create: () => T): T | null {
    const media = this.project?.media.find((m) => m.id === mediaId);
    if (!media) return null;
    const url = this.mediaUrl(media);
    let el = map.get(clipId);
    if (!el) {
      el = create();
      if (el instanceof HTMLMediaElement) {
        el.preload = "auto";
        el.addEventListener("seeked", this.onFrameReady);
        el.addEventListener("loadeddata", this.onFrameReady);
      } else {
        el.addEventListener("load", this.onFrameReady);
      }
      map.set(clipId, el);
    }
    if (el.dataset.url !== url) {
      // 換來源時保留目前的位置，sync 會再對準
      el.dataset.url = url;
      el.src = url;
    }
    return el;
  }

  /** 讓元素對準素材時間：播放中（只支援前進）就播並修正漂移，否則暫停並拖到位置 */
  private sync(el: HTMLMediaElement, srcTime: Seconds, playing: boolean, rate: number) {
    if (playing && rate > 0) {
      // 瀏覽器只接受 0.0625～16 倍（超出會拋 NotSupportedError）：4 倍速片段再按 L 快轉到 8 倍就會超過，夾住
      el.playbackRate = Math.min(16, Math.max(0.0625, rate));
      if (el.paused) {
        el.currentTime = srcTime;
        void el.play().catch(() => undefined);
      } else if (Math.abs(el.currentTime - srcTime) > PLAY_DRIFT * rate) {
        el.currentTime = srcTime;
      }
    } else {
      if (!el.paused) el.pause();
      // 拖曳播放頭時位置一直變：還在拖動（seeking）就先不改，等 seeked 觸發重畫時再對到最新位置。
      // 否則每次滑鼠移動都會中斷上一次拖動，畫面一直出不來。
      if (el.seeking) return;
      if (Math.abs(el.currentTime - srcTime) > SEEK_EPSILON) el.currentTime = srcTime;
    }
  }

  /**
   * 畫時間軸時間 t 這一格，並讓聲音對準。
   * playing／rate：播放狀態；倒退（rate < 0）時畫面逐格拖動、不出聲（瀏覽器不支援負的 playbackRate）。
   */
  render(t: Seconds, playing: boolean, rate: number) {
    const project = this.project;
    if (!project) return;
    const active = new Set<string>();

    this.compositor.begin();
    const { width, height } = this.canvas;
    // 依 §5.10 的順序畫：V1 → 3D 場景 → V2 以上 → 2D／3D 插件（layerPlan）
    /** 到目前為止畫過的圖層狀態（特效的下層畫面換了沒，靠它判斷） */
    let below = "";
    /** 這一格畫了幾個離線卡（e2e 讀 data-offline） */
    let offline = 0;
    for (const item of layerPlan(project, t, this.fps)) {
      if (item.kind !== "video") {
        // 特效：畫格由沙盒非同步畫，拿不到這一格時先畫上一張；要下層畫面的在這一刻（只畫到這一層）截圖
        if (!this.effects) continue;
        const effect = project.effects.find((e) => e.id === item.effectId)!;
        const req = { frame: item.frame, fps: this.fps, duration: item.duration, width, height, videoW: width, videoH: height };
        const bitmap = this.effects.frameFor(effect, req, () => createImageBitmap(this.canvas), below);
        if (bitmap) this.compositor.draw(bitmap, { x: 0, y: 0, w: 1, h: 1 }, 1);
        below += `|fx:${effect.id}:${bitmap ? "1" : "0"}`;
        continue;
      }
      const layer = item.layer;
      // 穿黑／白轉場的純色（§5.9）
      if (layer.solid) {
        this.compositor.drawSolid(layer.solid, layer.opacity);
        below += `|${layer.clipId}:${layer.opacity.toFixed(3)}`;
        continue;
      }
      active.add(layer.clipId);
      const media = project.media.find((m) => m.id === layer.mediaId);
      // 原檔找不到：畫「Media Offline」卡代替（不擋播放與剪輯）
      if (media?.offline) {
        this.compositor.draw(offlineCard(layer.rect.w * width, layer.rect.h * height), layer.rect, layer.opacity);
        offline++;
        below += `|${layer.clipId}:offline`;
        continue;
      }
      if (media?.kind === "image") {
        const img = this.element(this.images, layer.clipId, layer.mediaId, () => {
          const i = new Image();
          // 跨來源的圖不設 crossOrigin 會汙染 WebGL 貼圖（texImage2D 拋 SecurityError）
          i.crossOrigin = "anonymous";
          return i;
        });
        const ready = !!img?.complete && (img?.naturalWidth ?? 0) > 0;
        if (ready) this.compositor.draw(img!, layer.rect, layer.opacity, layer.crop, layer.grade);
        below += `|${layer.clipId}:${ready ? "1" : "0"}${layer.crop ? `:${JSON.stringify(layer.crop)}` : ""}${layerLook(layer)}`;
        continue;
      }
      const clip = project.clips.find((c) => c.id === layer.clipId)!;
      const el = this.element(this.videos, layer.clipId, layer.mediaId, () => {
        const v = document.createElement("video");
        v.muted = true;
        v.playsInline = true;
        v.crossOrigin = "anonymous";
        return v;
      });
      if (!el) continue;
      this.sync(el, layer.srcTime, playing, rate * clip.speed);
      const ready = el.readyState >= 2 && !el.seeking;
      if (ready) this.shown.set(el, el.currentTime);
      // 暫停中拖播放頭（D39）：影片還在跳轉或還沒載好時，縮圖比畫面上那一格更接近要的時間就先畫縮圖；
      // 只差一兩格（方向鍵逐格）時縮圖反而離得遠，照舊畫原本那一格，不會閃
      const thumb = !playing && !ready && this.thumbs ? this.thumbs.image(layer.mediaId, layer.srcTime, this.onFrameReady) : null;
      const shownAt = el.readyState >= 2 ? this.shown.get(el) ?? Infinity : Infinity;
      const useThumb = !!thumb && Math.abs(thumb.time - layer.srcTime) < Math.abs(shownAt - layer.srcTime);
      /** 這一格實際畫上去的影像（遮罩要用同一個） */
      let drawn: TexImageSource | null = null;
      if (useThumb) {
        drawn = thumb.img;
        this.canvas.dataset.thumbFrames = String(++this.thumbFrames);
      } else if (el.readyState >= 2) {
        drawn = el;
      }
      if (drawn) {
        this.compositor.draw(drawn, layer.rect, layer.opacity, layer.crop, layer.grade);
        // SAM 遮罩疊在這個影像圖層上（素材時間）；狀態併進 below，讀下層畫面的 3D 場景才會跟著重畫
        below += this.masks.draw(this.compositor, project, layer, drawn, width, height);
      }
      // 下層狀態含放大範圍：改了放大，讀下層畫面的特效（3D 場景）才會重畫
      below += `|${layer.clipId}@${el.currentTime.toFixed(3)}:${ready ? "1" : useThumb ? `t${thumb.time}` : "0"}${layer.crop ? `:${JSON.stringify(layer.crop)}` : ""}${layerLook(layer)}`;
    }

    this.canvas.dataset.offline = String(offline);
    // 字幕畫在最上層（預覽與匯出同一個 CaptionLayer）
    const captionCanvas = this.captionLayer.render(this.captions, this.captionWords, t, project.captionStyle ?? DEFAULT_CAPTION_STYLE, width, height);
    if (captionCanvas) this.compositor.draw(captionCanvas, { x: 0, y: 0, w: 1, h: 1 }, 1);

    const graph = currentAudioGraph();
    for (const voice of audioPlan(project, t)) {
      if (project.media.find((m) => m.id === voice.mediaId)?.offline) continue;
      active.add(voice.clipId);
      const el = this.element(this.audios, voice.clipId, voice.mediaId, () => {
        const a = document.createElement("audio");
        a.preservesPitch = true;
        // 跨來源（Tauri 的 asset 協定）也要讓 Web Audio 讀得到，必須在設 src 之前設
        a.crossOrigin = "anonymous";
        return a;
      });
      if (!el) continue;
      const gain = Math.max(0, voice.gain);
      if (graph) {
        const trackId = project.clips.find((c) => c.id === voice.clipId)!.trackId;
        graph.connect(voice.clipId, el, trackId);
        graph.setClipGain(voice.clipId, gain);
      } else {
        el.volume = Math.min(1, gain);
      }
      this.sync(el, voice.srcTime, playing, rate * voice.speed);
    }

    // 配樂軌依壓低曲線設匯流排增益
    if (graph) {
      for (const track of project.tracks) {
        if (track.kind === "audio" && track.role === "music") graph.setBusGain(track.id, this.duck ? gainAt(this.duck, t) : 1);
      }
    }

    // 2D 特效的音效：播放頭在特效範圍內就從特效起點算的時間播（跟片段一樣同步）
    for (const effect of project.effects) {
      const url = this.fxSounds.get(effect.id);
      if (!url || t < effect.start || t >= effect.end) continue;
      let el = this.fxAudios.get(effect.id);
      if (!el) {
        el = document.createElement("audio");
        el.dataset.src = url;
        el.src = url;
        this.fxAudios.set(effect.id, el);
      }
      const key = `fx:${effect.id}`;
      active.add(key);
      if (graph) graph.connect(key, el, "fx");
      this.sync(el, t - effect.start, playing, rate);
    }
    for (const [id, el] of this.fxAudios) if (!active.has(`fx:${id}`) && !el.paused) el.pause();

    // 這一格用不到的元素一律暫停
    for (const map of [this.videos, this.audios]) {
      for (const [id, el] of map) if (!active.has(id) && !el.paused) el.pause();
    }
  }

  /** 停止所有元素並釋放 */
  dispose() {
    for (const id of this.audios.keys()) currentAudioGraph()?.drop(id);
    for (const [id, el] of this.fxAudios) { el.pause(); currentAudioGraph()?.drop(`fx:${id}`); }
    this.fxAudios.clear();
    for (const map of [this.videos, this.images, this.audios] as Map<string, HTMLElement>[]) {
      for (const el of map.values()) {
        if (el instanceof HTMLMediaElement) el.pause();
        el.removeAttribute("src");
      }
      map.clear();
    }
  }
}
