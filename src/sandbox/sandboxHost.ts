// 2D 插件的沙盒宿主（spec §5.7、D35）：一個沙盒 iframe、裡面一個 Worker，跑原專案的直譯器（anim_vm）與執行環境。
// Worker 的原始碼（前置腳本＋acorn＋直譯器＋執行環境＋harness，約 400 KB）第一次用到時才載入，不放進主程式。
// 請求逾時（插件卡住）就整個 iframe 重建，之前記住的元件會重新送進去。
import { PluginError, SandboxFrame, WorkerChannel } from "./sandboxFrame";

export { PluginError };

/** 一般請求的逾時（毫秒）：超過就當插件卡住，重建沙盒 */
export const REQUEST_TIMEOUT = 2000;

/** 組 2D Worker 的原始碼（動態載入，拆成獨立分塊） */
async function workerSource(): Promise<string> {
  const parts = await Promise.all([
    import("./workerPrelude.js?raw"),
    import("../anim/vendor/acorn.js?raw"),
    import("../anim/vendor/anim_vm.js?raw"),
    import("../anim/vendor/anim_runtime.js?raw"),
    import("./animHarness.js?raw"),
  ]);
  return parts.map((m) => m.default).join("\n;\n");
}

/** 2D 沙盒宿主 */
export class SandboxHost {
  private frame: SandboxFrame | null = null;
  private channel: WorkerChannel | null = null;
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

  /** 建 iframe 與 Worker，並把記住的元件送進去 */
  private async start(): Promise<void> {
    const frame = new SandboxFrame("plugin-sandbox");
    this.frame = frame;
    const [source] = await Promise.all([workerSource(), frame.start()]);
    const port = await frame.startWorker("anim2d", source);
    this.channel = await WorkerChannel.open(port, () => this.restart(), REQUEST_TIMEOUT * 5);
    if (this.components.length) await this.channel.send("setComponents", { components: this.components }, [], REQUEST_TIMEOUT * 5);
  }

  /** 送請求（必要時先啟動） */
  async request<T>(type: string, payload: Record<string, unknown> = {}, transfer: Transferable[] = [], timeout = REQUEST_TIMEOUT): Promise<T> {
    await this.ready();
    return this.channel!.send<T>(type, payload, transfer, timeout);
  }

  /** 插件卡住：拆掉整個 iframe（連同 Worker），下次請求再重建 */
  private restart() {
    this.restarts++;
    this.channel?.fail("The effect sandbox was restarted");
    this.frame?.dispose();
    this.frame = null;
    this.channel = null;
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
