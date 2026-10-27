// 沙盒宿主（spec §5.7）：父頁這一側。建一個 sandbox="allow-scripts"（沒有 same-origin）的 srcdoc iframe，
// iframe 用自己的 CSP 擋網路，再在裡面以 blob URL 建 Worker 跑插件；畫格以 ImageBitmap 轉移，不複製畫素、不經 Rust。
// 沿用 spikes/sandbox 實測過的握手：iframe 啟動後 postMessage boot → 父頁轉移控制用 MessagePort → lockdown（刪 WebRTC）
// → start-worker（Worker 的資料通道 MessagePort 直接交回父頁，畫格不經 iframe 主執行緒）。
// 請求逾時（插件卡住）就整個 iframe 重建，之前記住的元件會重新送進去。
import acornSrc from "../anim/vendor/acorn.js?raw";
import vmSrc from "../anim/vendor/anim_vm.js?raw";
import runtimeSrc from "../anim/vendor/anim_runtime.js?raw";
import harnessSrc from "./animHarness.js?raw";
import iframeRuntimeSrc from "./iframeRuntime.js?raw";
import preludeSrc from "./workerPrelude.js?raw";

/** 插件執行錯誤（AnimError 帶階段、行、欄；給使用者看，也回饋給 Vibe特效的模型） */
export class PluginError extends Error {
  constructor(message: string, readonly stage: string | null, readonly line: number | null, readonly column: number | null) {
    super(message);
    this.name = "PluginError";
  }
}

/** iframe 啟動逾時（毫秒） */
const BOOT_TIMEOUT = 5000;
/** 一般請求的逾時（毫秒）：超過就當插件卡住，重建沙盒 */
export const REQUEST_TIMEOUT = 2000;

/** Worker 的完整原始碼：前置（固定亂數與時間）→ acorn → 直譯器 → 執行環境 → harness */
const WORKER_SOURCE = [preludeSrc, acornSrc, vmSrc, runtimeSrc, harnessSrc].join("\n;\n");

/** 計算文字的 CSP sha256 來源表達式 */
async function cspHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

/** 等待中的請求 */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 沙盒宿主 */
export class SandboxHost {
  private iframe: HTMLIFrameElement | null = null;
  /** 控制通道（iframe 主執行緒）與資料通道（Worker） */
  private ctrl: MessagePort | null = null;
  private data: MessagePort | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** 啟動中的 Promise（並行的請求共用同一次啟動） */
  private starting: Promise<void> | null = null;
  /** 已送進沙盒的元件（重建後要重送） */
  private readonly components: Record<string, unknown>[] = [];
  /** 重建次數（診斷用） */
  restarts = 0;

  /** 確保沙盒已啟動 */
  ready(): Promise<void> {
    if (!this.starting) this.starting = this.start().catch((e) => { this.starting = null; throw e; });
    return this.starting;
  }

  /** 建 iframe、握手、建 Worker，並把記住的元件送進去 */
  private async start(): Promise<void> {
    const hash = await cspHash(iframeRuntimeSrc);
    // spec §5.7 的 iframe CSP（再加 frame-src／base-uri／form-action，10/27 實測同樣可行）
    const csp = `default-src 'none'; script-src blob: ${hash}; worker-src blob:; connect-src 'none'; img-src blob: data:; frame-src 'none'; base-uri 'none'; form-action 'none'`;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("aria-hidden", "true");
    iframe.dataset.testid = "plugin-sandbox";
    iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    iframe.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>${iframeRuntimeSrc}</script></body></html>`;
    const booted = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { window.removeEventListener("message", onMsg); reject(new Error("Plugin sandbox did not start")); }, BOOT_TIMEOUT);
      const onMsg = (e: MessageEvent) => {
        if (e.source === iframe.contentWindow && e.data?.type === "boot") {
          window.removeEventListener("message", onMsg);
          clearTimeout(timer);
          resolve();
        }
      };
      window.addEventListener("message", onMsg);
    });
    document.body.appendChild(iframe);
    this.iframe = iframe;
    await booted;

    // 控制通道：轉移一個 MessagePort 進 iframe
    const mc = new MessageChannel();
    this.ctrl = mc.port1;
    const ctrlMessage = (pred: (d: { type: string; port?: MessagePort; message?: string }) => boolean) =>
      new Promise<{ type: string; port?: MessagePort }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Plugin sandbox handshake timed out")), BOOT_TIMEOUT);
        this.ctrl!.onmessage = (e) => {
          if (e.data?.type === "worker-error") console.error("plugin worker error:", e.data.message);
          if (pred(e.data)) { clearTimeout(timer); resolve(e.data); }
        };
      });
    const ready = ctrlMessage((d) => d.type === "ready");
    iframe.contentWindow!.postMessage({ type: "init", port: mc.port2 }, "*", [mc.port2]);
    await ready;
    const locked = ctrlMessage((d) => d.type === "locked");
    this.ctrl.postMessage({ cmd: "lockdown", id: 0 });
    await locked;

    // 建 Worker：資料通道直接交回父頁
    const port = ctrlMessage((d) => d.type === "worker-port");
    this.ctrl.postMessage({ cmd: "start-worker", source: WORKER_SOURCE, mode: "direct" });
    this.data = (await port).port!;
    const hello = new Promise<void>((resolve) => {
      this.data!.onmessage = (e) => {
        if (e.data?.type === "hello") { this.data!.onmessage = (m) => this.onData(m.data); resolve(); }
      };
    });
    await hello;
    if (this.components.length) await this.send("setComponents", { components: this.components }, [], REQUEST_TIMEOUT * 5);
  }

  /** Worker 的回覆 */
  private onData(d: { type: string; id: number; result?: unknown; error?: { message: string; stage: string | null; line: number | null; column: number | null } }) {
    const p = this.pending.get(d.id);
    if (!p) {
      // 逾時後才回來的畫格：釋放掉
      if (d.result instanceof ImageBitmap) d.result.close();
      return;
    }
    this.pending.delete(d.id);
    clearTimeout(p.timer);
    if (d.type === "error") p.reject(new PluginError(d.error!.message, d.error!.stage, d.error!.line, d.error!.column));
    else p.resolve(d.result);
  }

  /** 送一個請求給 Worker（已啟動時才用） */
  private send<T>(type: string, payload: Record<string, unknown>, transfer: Transferable[], timeout: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginError("The effect took too long to draw and was stopped", "timeout", null, null));
        this.restart();
      }, timeout);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.data!.postMessage({ type, id, ...payload }, transfer);
    });
  }

  /** 送請求（必要時先啟動） */
  async request<T>(type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = [], timeout = REQUEST_TIMEOUT): Promise<T> {
    await this.ready();
    return this.send<T>(type, payload, transfer, timeout);
  }

  /** 插件卡住：拆掉整個 iframe（連同 Worker），下次請求再重建 */
  private restart() {
    this.restarts++;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new PluginError("The effect sandbox was restarted", "timeout", null, null));
      this.pending.delete(id);
    }
    this.iframe?.remove();
    this.iframe = null;
    this.ctrl = null;
    this.data = null;
    this.starting = null;
  }

  /** 把元件送進沙盒（驗證並算雜湊）；回傳各元件的雜湊 */
  async setComponents(components: Record<string, unknown>[]): Promise<string[]> {
    const { hashes } = await this.request<{ hashes: string[] }>("setComponents", { components }, [], REQUEST_TIMEOUT * 5);
    this.components.push(...components);
    return hashes;
  }

  /** 拆掉沙盒 */
  dispose() {
    this.restart();
    this.restarts--;
  }
}
