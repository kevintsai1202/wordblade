// 縮圖序列的狀態與背景排程（D39）：記各素材做好的段、把縮圖網址與圖片快取起來給預覽與時間軸同步取用，
// 並在空檔（沒播放、沒有重工作）一段一段產生更細的層。產生與存檔交給 Engine。
import type { Media } from "../core/model";
import type { Engine } from "../engine/Engine";
import { TIERS, chunkCount, nextJob, pickThumb, type DoneMap, type ThumbItem, type ThumbJob, type ThumbRef } from "./thumbs";

/** ThumbStore 用到的 Engine 功能（測試換成假的） */
export type ThumbEngine = Pick<Engine, "makeThumbs" | "thumbStatus" | "thumbUrl">;

/** 網址快取的上限：網頁版是 blob: 網址，超過就釋放最久沒用的（一小時影片的第三層有 7200 張，不能全留著） */
const MAX_URLS = 800;
/** 預覽用的已載入圖片上限 */
const MAX_IMAGES = 48;

/** 一張縮圖的快取鍵 */
const keyOf = (mediaId: string, ref: { tier: number; index: number }) => `${mediaId}:${ref.tier}:${ref.index}`;

/** 縮圖序列的狀態：各素材做好的段、網址與圖片快取 */
export class ThumbStore {
  /** 追蹤中的影片與做好的段 */
  private entries = new Map<string, { media: Media; done: DoneMap; failed: boolean }>();
  /** 縮圖網址（Map 的順序當作 LRU：用到就移到最後） */
  private urls = new Map<string, string>();
  /** 正在取得網址的縮圖 */
  private pending = new Set<string>();
  /** 預覽用的圖片元素（載入好的才拿來畫） */
  private images = new Map<string, HTMLImageElement>();
  private listeners = new Set<() => void>();
  /** 每次有變動（段做好、網址拿到）就加一；React 用它重畫 */
  version = 0;

  constructor(private engine: ThumbEngine) {}

  /** 訂閱變動；回傳取消訂閱 */
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** 跟專案的素材清單同步：新的影片讀快取狀態、素材資訊更新（代理檔做好）、移除的釋放網址 */
  async sync(list: Media[]) {
    const videos = list.filter((m) => m.kind === "video");
    const ids = new Set(videos.map((m) => m.id));
    for (const id of [...this.entries.keys()]) {
      if (ids.has(id)) continue;
      this.entries.delete(id);
      for (const [key, url] of this.urls) if (key.startsWith(`${id}:`)) { this.release(url); this.urls.delete(key); }
      for (const key of [...this.images.keys()]) if (key.startsWith(`${id}:`)) this.images.delete(key);
    }
    await Promise.all(videos.map((m) => this.track(m)));
    this.changed();
  }

  /** 開始追蹤一支影片（已追蹤就更新素材資訊）：讀快取裡做好的段 */
  async track(media: Media) {
    if (media.kind !== "video") return;
    const entry = this.entries.get(media.id);
    if (entry) {
      entry.media = media;
      return;
    }
    this.entries.set(media.id, { media, done: TIERS.map(() => []), failed: false });
    try {
      const done = await this.engine.thumbStatus(media);
      const e = this.entries.get(media.id);
      if (e) e.done = TIERS.map((_, t) => [...new Set([...(done[t] ?? []), ...e.done[t]])]);
    } catch {
      /* 讀不到快取狀態就當作都沒做 */
    }
    this.changed();
  }

  /** 排程看的素材（產生失敗的跳過） */
  items(): ThumbItem[] {
    return [...this.entries.values()].filter((e) => !e.failed).map((e) => ({ mediaId: e.media.id, duration: e.media.duration, done: e.done }));
  }

  /** 素材時間 t 要顯示哪一張 */
  pick(mediaId: string, t: number): ThumbRef | null {
    const e = this.entries.get(mediaId);
    return e ? pickThumb(e.done, e.media.duration, t) : null;
  }

  /** 縮圖網址；還沒拿到回 null 並在背景取得（拿到後通知） */
  url(mediaId: string, ref: { tier: number; index: number }): string | null {
    const key = keyOf(mediaId, ref);
    const hit = this.urls.get(key);
    if (hit) {
      this.urls.delete(key);
      this.urls.set(key, hit);
      return hit;
    }
    const e = this.entries.get(mediaId);
    if (!e || this.pending.has(key)) return null;
    this.pending.add(key);
    void this.engine.thumbUrl(e.media, ref.tier, ref.index).then((url) => {
      this.pending.delete(key);
      if (!url || !this.entries.has(mediaId)) return;
      this.urls.set(key, url);
      while (this.urls.size > MAX_URLS) {
        const [oldKey, oldUrl] = this.urls.entries().next().value!;
        this.urls.delete(oldKey);
        this.images.delete(oldKey);
        this.release(oldUrl);
      }
      this.changed();
    }, () => this.pending.delete(key));
    return null;
  }

  /**
   * 預覽用：素材時間 t 最近的一張、已經載入好的圖片；還沒有就回 null 並開始載入（載好後 onReady 讓預覽重畫）。
   * 圖片設 crossOrigin，否則 WebGL 貼圖會被汙染。
   */
  image(mediaId: string, t: number, onReady: () => void): { img: HTMLImageElement; time: number } | null {
    const ref = this.pick(mediaId, t);
    if (!ref) return null;
    const key = keyOf(mediaId, ref);
    const img = this.images.get(key);
    if (img) return img.complete && img.naturalWidth > 0 ? { img, time: ref.time } : null;
    const url = this.url(mediaId, ref);
    if (!url) return null;
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = onReady;
    el.src = url;
    this.images.set(key, el);
    while (this.images.size > MAX_IMAGES) this.images.delete(this.images.keys().next().value!);
    return null;
  }

  /**
   * AI 取畫面（D39；AI 導演逐段分析用）：素材時間 t 最近的一張（做好的最細一層）的 JPEG；都沒做好回 null。
   * 不經過預覽、不用現場跳轉解碼。Vibe 仍用預覽的合成畫面（含字幕與特效，參考價值較高）。
   */
  async thumbnailAt(mediaId: string, t: number): Promise<{ blob: Blob; time: number; width: number } | null> {
    const e = this.entries.get(mediaId);
    const ref = this.pick(mediaId, t);
    if (!e || !ref) return null;
    const cached = this.urls.get(keyOf(mediaId, ref));
    const url = cached ?? (await this.engine.thumbUrl(e.media, ref.tier, ref.index));
    if (!url) return null;
    try {
      const blob = await (await fetch(url)).blob();
      return { blob, time: ref.time, width: TIERS[ref.tier].width };
    } finally {
      if (!cached) this.release(url);
    }
  }

  /** 做一件工作（某支素材某一層的某一段）；失敗的素材之後跳過 */
  async run(job: ThumbJob) {
    const e = this.entries.get(job.mediaId);
    if (!e) return;
    try {
      await this.engine.makeThumbs(e.media, job.tier, job.chunk);
      if (!e.done[job.tier].includes(job.chunk)) e.done[job.tier].push(job.chunk);
    } catch {
      e.failed = true;
    }
    this.changed();
  }

  /** 把某支素材的某一層全部做完（匯入時的第一層，在素材準備的佇列裡跑） */
  async runTier(mediaId: string, tier: number) {
    const e = this.entries.get(mediaId);
    if (!e) return;
    for (let chunk = 0; chunk < chunkCount(e.media.duration) && !e.failed; chunk++) {
      if (!e.done[tier].includes(chunk)) await this.run({ mediaId, tier, chunk });
    }
  }

  /** 換專案：清掉全部 */
  clear() {
    for (const url of this.urls.values()) this.release(url);
    this.urls.clear();
    this.images.clear();
    this.entries.clear();
    this.changed();
  }

  /** 釋放 blob: 網址（桌面版的檔案網址不用） */
  private release(url: string) {
    if (url.startsWith("blob:")) URL.revokeObjectURL(url);
  }
}

/** 背景排程：空檔（isIdle）時一次做一段，忙就每 pollMs 再看一次 */
export class ThumbScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(private store: ThumbStore, private isIdle: () => boolean, private pollMs = 1000) {}

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(ms: number) {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), ms);
  }

  /** 看一次：空檔又有工作就做一段，做完馬上看下一段 */
  private async tick() {
    if (!this.running) return;
    const job = this.isIdle() ? nextJob(this.store.items()) : null;
    if (!job) return this.schedule(this.pollMs);
    await this.store.run(job);
    this.schedule(0);
  }
}
