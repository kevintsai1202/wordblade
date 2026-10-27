// 插件服務：整個 app 共用一個沙盒，啟動時把內建元件送進去拿到雜湊（範本的圖層用雜湊指到元件）。
import type { Plugin } from "../core/model";
import { SandboxHost } from "../sandbox/sandboxHost";
import { ThreeHost } from "../sandbox/threeHost";
import { COMPONENTS } from "./library";

/** 內建插件：元件 id → 插件（含沙盒算出的雜湊） */
export type BuiltinPlugins = Map<string, Plugin>;

/** 插件服務 */
export class PluginService {
  readonly host = new SandboxHost();
  /** 3D 插件的沙盒（獨立 iframe） */
  readonly three = new ThreeHost();
  private builtinsPromise: Promise<BuiltinPlugins> | null = null;

  /** 內建視覺元件送進沙盒（只做一次）；音效元件今天先不用（§5.15 另做） */
  builtins(): Promise<BuiltinPlugins> {
    if (!this.builtinsPromise) {
      const visual = COMPONENTS.filter((c) => c.kind === "visual");
      this.builtinsPromise = this.host.setComponents(visual).then((hashes) => {
        const map: BuiltinPlugins = new Map();
        visual.forEach((c, i) => map.set(c.id, { hash: hashes[i], kind: "2d", source: "builtin", component: c }));
        return map;
      });
    }
    return this.builtinsPromise;
  }
}
