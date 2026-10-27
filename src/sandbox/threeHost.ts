// 3D 插件的沙盒宿主（spec §5.7、§5.8）：獨立的沙盒 iframe（3D 插件卡住重建時不影響 2D），每個 3D 特效一個 Worker。
// Worker 原始碼＝前置腳本（固定亂數與時間）＋three.js（THREE 全域）＋插件程式＋harness；three.js（約 2 MB）第一次用到才載入。
// 插件程式直接串進原始碼（iframe 的 CSP 沒有 unsafe-eval，Worker 裡不能 new Function）。
// 逾時：建場景與第一格 10 秒（軟體算繪第一次編 shader 慢），之後每格 2 秒；逾時只終止那個特效的 Worker。
import { PluginError, SandboxFrame, WorkerChannel } from "./sandboxFrame";

/** 第一格（含建場景、編 shader）的逾時 */
const FIRST_TIMEOUT = 10_000;
/** 之後每格的逾時 */
const FRAME_TIMEOUT = 2000;

/** 前置腳本＋three.js 的原始碼（只組一次） */
let baseSource: Promise<string> | null = null;

/**
 * 組 3D Worker 的共用部分：three.cjs 包成 THREE 全域（它是單一自足的 CommonJS 檔）。
 * three 的 package exports 沒開放 build/three.cjs，所以用相對路徑直接讀檔（?raw）。
 */
function loadBase(): Promise<string> {
  if (!baseSource) {
    baseSource = Promise.all([import("./workerPrelude.js?raw"), import("../../node_modules/three/build/three.cjs?raw")]).then(([prelude, three]) =>
      `${prelude.default}\n;\nvar THREE = (function () { var module = { exports: {} }; var exports = module.exports;\n${three.default}\n;return module.exports; })();\n`);
  }
  return baseSource;
}

/** 一個特效的 Worker */
interface Slot {
  channel: WorkerChannel;
  /** 插件程式（換了就重建 Worker） */
  code: string;
  /** 畫過第一格了嗎（決定逾時） */
  warm: boolean;
}

/** 3D 沙盒宿主 */
export class ThreeHost {
  private frame: SandboxFrame | null = null;
  private starting: Promise<void> | null = null;
  private readonly slots = new Map<string, Promise<Slot>>();
  /** 逾時被終止的次數（診斷用） */
  kills = 0;

  /** 確保 iframe 已啟動 */
  private ready(): Promise<void> {
    if (!this.starting) {
      const frame = new SandboxFrame("plugin-sandbox-3d");
      this.frame = frame;
      this.starting = frame.start().catch((e) => { this.starting = null; throw e; });
    }
    return this.starting;
  }

  /** 取得（必要時建立）某個特效的 Worker；插件程式換了就重建 */
  private async slot(effectId: string, code: string): Promise<Slot> {
    const existing = this.slots.get(effectId);
    if (existing) {
      const s = await existing.catch(() => null);
      if (s && s.code === code) return s;
      this.kill(effectId);
    }
    const created = (async () => {
      const [base] = await Promise.all([loadBase(), this.ready()]);
      const harness = (await import("./threeHarness.js?raw")).default;
      const port = await this.frame!.startWorker(`3d:${effectId}`, `${base}\n;\n${code}\n;\n${harness}`);
      const channel = await WorkerChannel.open(port, () => this.kill(effectId), FIRST_TIMEOUT);
      return { channel, code, warm: false };
    })();
    this.slots.set(effectId, created);
    created.catch(() => this.slots.delete(effectId));
    return created;
  }

  /** 終止某個特效的 Worker（逾時或插件換了） */
  private kill(effectId: string) {
    const s = this.slots.get(effectId);
    this.slots.delete(effectId);
    this.frame?.killWorker(`3d:${effectId}`);
    void s?.then((x) => x.channel.fail("The 3D effect was stopped"), () => undefined);
    this.kills++;
  }

  /** 畫一格（background：下層畫面，會轉移進沙盒） */
  async render(effectId: string, code: string, payload: Record<string, unknown>, background: ImageBitmap | null): Promise<ImageBitmap> {
    const s = await this.slot(effectId, code);
    const timeout = s.warm ? FRAME_TIMEOUT : FIRST_TIMEOUT;
    const bitmap = await s.channel.send<ImageBitmap>("render", { ...payload, background }, background ? [background] : [], timeout);
    s.warm = true;
    return bitmap;
  }

  /** 試跑插件（Vibe特效 3D）：建場景、畫開頭／中間／結尾三格，至少一格有東西；用暫時的 Worker，跑完就終止 */
  async vet(code: string, payload: Record<string, unknown>): Promise<{ lit: number[] }> {
    const id = `vet-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const s = await this.slot(id, code);
      return await s.channel.send<{ lit: number[] }>("vet", payload, [], FIRST_TIMEOUT * 2);
    } catch (e) {
      throw e instanceof PluginError ? e : new PluginError(String(e), "load", null, null);
    } finally {
      this.kill(id);
      this.kills--;
    }
  }

  /** 不在專案裡的特效：終止它們的 Worker */
  prune(effectIds: Set<string>) {
    for (const id of [...this.slots.keys()]) if (!effectIds.has(id) && !id.startsWith("vet-")) { this.kill(id); this.kills--; }
  }

  /** 拆掉沙盒 */
  dispose() {
    for (const id of [...this.slots.keys()]) this.kill(id);
    this.frame?.dispose();
    this.frame = null;
    this.starting = null;
  }
}
