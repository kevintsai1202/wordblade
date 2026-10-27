import { isTauri as detectTauri } from "@tauri-apps/api/core";
import { DesktopEngine } from "./DesktopEngine";
import type { Engine } from "./Engine";
import { WebEngine } from "./WebEngine";

/** 建立 Engine 時的環境偵測；測試可以換掉 */
export interface EngineEnvironment {
  /** 是否跑在 Tauri 的 WebView 裡 */
  isTauri: () => boolean;
}

/** 依執行環境選 Engine：Tauri 裡用桌面版，其餘用網頁版 */
export function createEngine(env: EngineEnvironment = { isTauri: detectTauri }): Engine {
  return env.isTauri() ? new DesktopEngine() : new WebEngine();
}
