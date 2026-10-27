// 沙盒 iframe（spec §5.7）：sandbox="allow-scripts"（沒有 same-origin）的 srcdoc iframe，用自己的 CSP 擋網路；
// 在裡面以 blob URL 建 Worker 跑插件，Worker 的資料通道（MessagePort）直接交回父頁，畫格不經 iframe 主執行緒。
// 沿用 spikes/sandbox 實測過的握手：iframe 啟動後 postMessage boot → 父頁轉移控制用 MessagePort → lockdown（刪 WebRTC）。
// 2D 沙盒（sandboxHost）與 3D 沙盒（threeHost）各用一個，互不影響：3D 插件卡住重建時不會連帶清掉 2D。

/** iframe 啟動逾時（毫秒） */
const BOOT_TIMEOUT = 5000;

/** 計算文字的 CSP sha256 來源表達式 */
async function cspHash(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

/** iframe 控制通道的訊息 */
interface CtrlMessage {
  type: string;
  id?: string;
  port?: MessagePort;
  message?: string;
}

/** 沙盒 iframe */
export class SandboxFrame {
  private iframe: HTMLIFrameElement | null = null;
  private ctrl: MessagePort | null = null;
  /** 等待中的控制訊息 */
  private readonly waiters: { pred: (d: CtrlMessage) => boolean; resolve: (d: CtrlMessage) => void }[] = [];

  /** @param testId iframe 的 data-testid（e2e 用） */
  constructor(private readonly testId: string) {}

  /** 建 iframe、握手、lockdown */
  async start(): Promise<void> {
    const runtime = (await import("./iframeRuntime.js?raw")).default;
    const hash = await cspHash(runtime);
    // spec §5.7 的 iframe CSP（再加 frame-src／base-uri／form-action，10/27 實測同樣可行）
    const csp = `default-src 'none'; script-src blob: ${hash}; worker-src blob:; connect-src 'none'; img-src blob: data:; frame-src 'none'; base-uri 'none'; form-action 'none'`;
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.setAttribute("aria-hidden", "true");
    iframe.dataset.testid = this.testId;
    iframe.style.cssText = "position:absolute;width:0;height:0;border:0;visibility:hidden";
    iframe.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body><script>${runtime}</script></body></html>`;
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

    const mc = new MessageChannel();
    this.ctrl = mc.port1;
    this.ctrl.onmessage = (e) => this.onCtrl(e.data as CtrlMessage);
    const ready = this.wait((d) => d.type === "ready");
    iframe.contentWindow!.postMessage({ type: "init", port: mc.port2 }, "*", [mc.port2]);
    await ready;
    const locked = this.wait((d) => d.type === "locked");
    this.ctrl.postMessage({ cmd: "lockdown", id: 0 });
    await locked;
  }

  /** 控制通道收到訊息：叫醒符合條件的等待者 */
  private onCtrl(d: CtrlMessage) {
    if (d.type === "worker-error") console.error(`plugin worker ${d.id} error:`, d.message);
    for (const w of [...this.waiters]) {
      if (w.pred(d)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(d);
      }
    }
  }

  /** 等一則符合條件的控制訊息 */
  private wait(pred: (d: CtrlMessage) => boolean): Promise<CtrlMessage> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Plugin sandbox handshake timed out")), BOOT_TIMEOUT);
      this.waiters.push({ pred, resolve: (d) => { clearTimeout(timer); resolve(d); } });
    });
  }

  /** 在 iframe 裡建一個 Worker，回傳它的資料通道 */
  async startWorker(id: string, source: string): Promise<MessagePort> {
    const port = this.wait((d) => d.type === "worker-port" && d.id === id);
    this.ctrl!.postMessage({ cmd: "start-worker", id, source });
    return (await port).port!;
  }

  /** 終止一個 Worker */
  killWorker(id: string) {
    this.ctrl?.postMessage({ cmd: "kill-worker", id });
  }

  /** 拆掉 iframe（連同所有 Worker） */
  dispose() {
    this.iframe?.remove();
    this.iframe = null;
    this.ctrl = null;
  }
}

/** 插件執行錯誤（AnimError 帶階段、行、欄；給使用者看，也回饋給 Vibe特效的模型） */
export class PluginError extends Error {
  constructor(message: string, readonly stage: string | null, readonly line: number | null, readonly column: number | null) {
    super(message);
    this.name = "PluginError";
  }
}

/** 等待中的請求 */
interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * 一個 Worker 的請求通道：每個請求帶 id，Worker 回 {type:'result', id, result} 或 {type:'error', id, error}。
 * 逾時呼叫 onTimeout（宿主決定要重建 Worker 還是整個 iframe）。
 */
export class WorkerChannel {
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(private readonly port: MessagePort, private readonly onTimeout: () => void) {
    port.onmessage = (e) => this.onData(e.data);
  }

  /** 等 Worker 說 hello（腳本載入完成） */
  static async open(port: MessagePort, onTimeout: () => void, timeout: number): Promise<WorkerChannel> {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PluginError("The effect sandbox did not start", "timeout", null, null)), timeout);
      port.onmessage = (e) => {
        if (e.data?.type === "hello") { clearTimeout(timer); resolve(); }
        else if (e.data?.type === "error") { clearTimeout(timer); reject(new PluginError(e.data.error?.message ?? "plugin error", e.data.error?.stage ?? "load", e.data.error?.line ?? null, e.data.error?.column ?? null)); }
      };
    });
    return new WorkerChannel(port, onTimeout);
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

  /** 送一個請求 */
  send<T>(type: string, payload: Record<string, unknown>, transfer: Transferable[], timeout: number): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PluginError("The effect took too long to draw and was stopped", "timeout", null, null));
        this.onTimeout();
      }, timeout);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.port.postMessage({ type, id, ...payload }, transfer);
    });
  }

  /** 通道作廢：所有等待中的請求都失敗 */
  fail(message: string) {
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new PluginError(message, "timeout", null, null));
      this.pending.delete(id);
    }
    this.port.close();
  }
}
