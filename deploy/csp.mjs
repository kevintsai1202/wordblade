// 父頁 CSP（spec §5.7）：網頁版（nginx）、Windows 版（tauri.conf.json）、e2e（vite preview）共用這一份。
// 沙盒是 srcdoc iframe，會繼承父頁 CSP（兩份取交集），所以父頁的 script-src 要放行沙盒啟動腳本的 sha256；
// 雜湊在這裡從 src/sandbox/iframeRuntime.js 算（換行統一成 LF，和執行時 sandboxFrame.ts 算的一樣）。
// 用法：node deploy/csp.mjs → 印出網頁版的 CSP（web-zeabur.ps1 組 nginx.conf 時用）；--desktop → Windows 版；--desktop --dev → tauri dev
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** 沙盒啟動腳本 */
const RUNTIME = fileURLToPath(new URL("../src/sandbox/iframeRuntime.js", import.meta.url));

/** 沙盒啟動腳本的 CSP sha256 來源表達式 */
export function runtimeHash() {
  const text = readFileSync(RUNTIME, "utf8").replace(/\r\n?/g, "\n");
  return `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
}

/** Windows 版的素材網址（Tauri asset 協定在 Windows 是 http://asset.localhost） */
const ASSET = "http://asset.localhost asset:";

/**
 * 父頁 CSP。
 * - connect-src 放行 https:：閘道網址可以在設定裡改（開發者 2026-11-01 決定）；本機實測的閘道是 http://localhost。
 * - frame-src 'none'：擋沙盒 iframe 自我導航外洩（iframe 自己的 CSP 擋不了，spikes/sandbox/RESULT.md）。
 * - worker-src blob:：沙盒在 iframe 裡用 blob URL 建 Worker；script-src 不加 blob:（Worker 路線不需要）。
 * @param {{ desktop?: boolean, dev?: boolean }} [options] desktop：Windows 版（加素材協定與 IPC）；
 *   dev：tauri dev 用（tauri.conf 的 devCsp；設 null 會被當成沒設而套用正式 CSP）——Vite 開發伺服器有 React 的行內前置腳本與 HMR 的 WebSocket，
 *   script-src 改成 'unsafe-inline'（有雜湊時瀏覽器會忽略 unsafe-inline，所以不放雜湊；沙盒的行內啟動腳本同樣放行）
 */
export function parentCsp({ desktop = false, dev = false } = {}) {
  const asset = desktop ? ` ${ASSET}` : "";
  // Tauri 的 IPC（invoke 走 ipc: 自訂協定；被擋時會退回 postMessage，raw body 的 Uint8Array 就傳不過去）
  const ipc = desktop ? " ipc: http://ipc.localhost" : "";
  return [
    "default-src 'none'",
    dev ? "script-src 'self' 'unsafe-inline'" : `script-src 'self' ${runtimeHash()}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' blob: data:${asset}`,
    `media-src 'self' blob: data:${asset}`,
    "font-src 'self' data:",
    `connect-src 'self' https: blob: data: http://localhost:* http://127.0.0.1:*${asset}${ipc}${dev ? " ws://localhost:*" : ""}`,
    "worker-src blob:",
    "frame-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.stdout.write(parentCsp({ desktop: process.argv.includes("--desktop"), dev: process.argv.includes("--dev") }));
}
