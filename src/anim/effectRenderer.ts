// 預覽用的 2D 特效畫格管理（spec §5.7、§5.13）：向沙盒要畫格，畫格是非同步回來的 ImageBitmap。
// 每個特效同時只送一個請求、以最新的為準（播放 30 fps 時請求會比沙盒畫得快，不限制就會一直排隊）；
// 沒拿到目前這一格時先畫上一張（可能慢一格），拿到就通知外面重畫。
// 匯出時（10/31）改用 renderFrame 逐格 await，結果和預覽同一套。
import type { Effect, Plugin, Project } from "../core/model";
import { PluginError, type SandboxHost } from "../sandbox/sandboxHost";
import type { ThreeHost } from "../sandbox/threeHost";

/** 畫格的請求內容（不含特效本身） */
export interface FrameRequest {
  frame: number;
  fps: number;
  duration: number;
  /** 畫格像素尺寸（預覽畫布或輸出尺寸） */
  width: number;
  height: number;
  /** 片子比例（決定 1080p 虛擬座標的寬） */
  videoW: number;
  videoH: number;
}

/** 某個特效目前拿到的畫格 */
interface Slot {
  /** 畫格內容的鍵（特效參數＋格數＋尺寸）；和目前要的一樣才算「這一格」 */
  key: string;
  bitmap: ImageBitmap | null;
  /** 正在等的請求鍵（null：沒有） */
  inflight: string | null;
  /** 請求回來時要不要再送一次（期間又要了別格）；background 是當時截的下層畫面 */
  wanted: { key: string; effect: Effect; req: FrameRequest; background: Promise<ImageBitmap> | null } | null;
  error: PluginError | null;
}

/** 特效 → 沙盒的動畫實例（drawFrame 的 instance） */
export function instanceOf(effect: Effect): Record<string, unknown> {
  return { ...effect.params, id: effect.id };
}

/** 2D 特效畫格管理 */
export class EffectRenderer {
  private readonly slots = new Map<string, Slot>();
  /** 已送進沙盒的元件雜湊 */
  private readonly sent = new Set<string>();
  /** 特效有沒有圖層讀下層畫面（依參數快取） */
  private readonly bgCache = new Map<string, boolean | undefined>();

  /** 3D 插件的程式：插件雜湊 → 程式碼 */
  private readonly code3D = new Map<string, string>();

  /**
   * @param host 2D 沙盒
   * @param three 3D 沙盒
   * @param onFrame 新畫格回來時呼叫（讓預覽重畫）
   */
  constructor(private readonly host: SandboxHost, private readonly three: ThreeHost, private readonly onFrame: () => void) {}

  /** 把專案裡還沒送進沙盒的插件送進去（2D 送進直譯器驗證；3D 只記住程式，畫的時候才建 Worker） */
  async syncPlugins(plugins: Plugin[]): Promise<void> {
    for (const p of plugins) if (p.kind === "3d") this.code3D.set(p.hash, String(p.component.code ?? ""));
    const fresh = plugins.filter((p) => p.kind === "2d" && !this.sent.has(p.hash));
    if (!fresh.length) return;
    for (const p of fresh) this.sent.add(p.hash);
    await this.host.setComponents(fresh.map((p) => p.component));
  }

  /** 這個特效有沒有圖層要讀下層畫面（要的話預覽才把畫面讀回送進去）；回傳 undefined 表示還在問沙盒 */
  usesBackground(effect: Effect): boolean | undefined {
    // 3D 一律要當格畫面（場景把它當貼圖）
    if (effect.kind !== "anim2d") return true;
    const key = JSON.stringify(effect.params);
    if (!this.bgCache.has(key)) {
      this.bgCache.set(key, undefined);
      this.host.request<boolean>("usesBackground", { instance: instanceOf(effect) }).then(
        (uses) => { this.bgCache.set(key, uses); if (uses) this.onFrame(); },
        () => this.bgCache.set(key, false),
      );
    }
    return this.bgCache.get(key);
  }

  /** 直接要一格（匯出用：逐格 await；background 是下層畫面，會轉移進沙盒） */
  renderFrame(effect: Effect, req: FrameRequest, background: ImageBitmap | null = null): Promise<ImageBitmap> {
    if (effect.kind !== "anim2d") {
      const code = this.code3D.get(effect.pluginId);
      if (code === undefined) {
        background?.close();
        return Promise.reject(new PluginError("Missing 3D plugin", "load", null, null));
      }
      const p = effect.params as { params?: Record<string, unknown>; box?: unknown };
      // 鏡頭關鍵幀（3D 場景）跟著參數送進插件
      const params = effect.cameraKeys?.length ? { ...(p.params ?? {}), cameraKeys: effect.cameraKeys } : p.params ?? {};
      return this.three.render(effect.id, code, { ...req, params, box: p.box ?? null, seed: 1 }, background);
    }
    return this.host.request<ImageBitmap>("render", { instance: instanceOf(effect), ...req, background }, background ? [background] : []);
  }

  /**
   * 預覽：回傳目前能畫的畫格（可能是上一格），並在需要時送出新的請求。
   * snapshot：截下層畫面（合成器剛畫完影片層時同步呼叫 createImageBitmap）；只有這個特效讀 bg、而且真的要送請求時才呼叫，
   * 沒用到 bg 的特效不讀回，省 18～36 ms。belowKey：下層畫面的狀態（PreviewPlayer 依畫過的圖層組）。
   */
  frameFor(effect: Effect, req: FrameRequest, snapshot: (() => Promise<ImageBitmap>) | null, belowKey = ""): ImageBitmap | null {
    // 讀下層畫面的特效：下層的內容（各影片的時間、載好沒）也算進鍵，下層換了（例如影片剛載好）就要重畫
    const uses = this.usesBackground(effect);
    const key = `${JSON.stringify(effect.params)}|${JSON.stringify(effect.cameraKeys ?? null)}|${req.frame}|${req.duration}|${req.width}x${req.height}${uses ? `|${belowKey}` : ""}`;
    let slot = this.slots.get(effect.id);
    if (!slot) {
      slot = { key: "", bitmap: null, inflight: null, wanted: null, error: null };
      this.slots.set(effect.id, slot);
    }
    if (slot.key !== key && slot.inflight !== key && slot.wanted?.key !== key) {
      const background = snapshot && uses ? snapshot() : null;
      if (slot.inflight) {
        // 前一個還沒回來：只記住最新要的那一格，被取代的截圖釋放掉
        void slot.wanted?.background?.then((b) => b.close());
        slot.wanted = { key, effect, req, background };
      } else {
        void this.fetch(effect.id, slot, key, effect, req, background);
      }
    }
    return slot.bitmap;
  }

  /** 送一個請求；回來後若期間又要了別格，接著送最新的那一格 */
  private async fetch(effectId: string, slot: Slot, key: string, effect: Effect, req: FrameRequest, background: Promise<ImageBitmap> | null) {
    slot.inflight = key;
    try {
      const bg = background ? await background : null;
      const bitmap = await this.renderFrame(effect, req, bg);
      if (this.slots.get(effectId) !== slot) { bitmap.close(); return; }
      slot.bitmap?.close();
      slot.bitmap = bitmap;
      slot.key = key;
      slot.error = null;
    } catch (e) {
      slot.error = e instanceof PluginError ? e : new PluginError(String(e), null, null, null);
      slot.key = key;
    } finally {
      slot.inflight = null;
    }
    this.onFrame();
    const next = slot.wanted;
    slot.wanted = null;
    if (next && next.key !== slot.key) void this.fetch(effectId, slot, next.key, next.effect, next.req, next.background);
    else void next?.background?.then((b) => b.close());
  }

  /** 特效最近一次畫格錯誤（介面顯示用） */
  errorOf(effectId: string): PluginError | null {
    return this.slots.get(effectId)?.error ?? null;
  }

  /** 專案換了：不在專案裡的特效畫格與 3D Worker 釋放掉 */
  prune(project: Project) {
    const ids = new Set(project.effects.map((e) => e.id));
    this.three.prune(ids);
    for (const [id, slot] of this.slots) {
      if (ids.has(id)) continue;
      slot.bitmap?.close();
      this.slots.delete(id);
    }
  }

  /** 全部釋放 */
  dispose() {
    for (const slot of this.slots.values()) slot.bitmap?.close();
    this.slots.clear();
  }
}
