/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from "vite";
import { readFile } from "node:fs/promises";
import react from "@vitejs/plugin-react";
import { samplesPlugin } from "./vite.samples";
import process from "node:process";
import { parentCsp } from "./deploy/csp.mjs";
const host = process.env.TAURI_DEV_HOST;

/**
 * 經典腳本當 ES 模組載入：`import X from "./a.js?global=NAME"` → 檔案原文後面接 `export default NAME`。
 * 取代執行字串（new Function），父頁 CSP 不放行 'unsafe-eval'（2026-11-01）。
 */
function classicGlobalPlugin(): Plugin {
  return {
    name: "classic-global",
    enforce: "pre",
    async load(id) {
      const m = /^(.*)\?global=([A-Za-z_$][\w$]*)$/.exec(id);
      if (!m) return null;
      const code = await readFile(m[1], "utf8");
      // 經典腳本結尾有「Node 就 module.exports = …」：遮住 module，免得 Vitest 的模組環境把它當 CommonJS
      return `const module = undefined;
${code}
export default ${m[2]};
`;
    },
  };
}

/** 跨來源隔離（crossOriginIsolated，WASM 多執行緒與 JASSUB 要用，§5.21）：和 nginx（網頁版）、tauri.conf（Windows 版）同一組 */
const ISOLATION_HEADERS = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [classicGlobalPlugin(), react(), samplesPlugin()],


  // 單元測試只跑 src（e2e、spikes、gateway 各有自己的測試）
  test: { include: ["src/**/*.test.ts"] },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    headers: ISOLATION_HEADERS,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
  // mediabunny（網頁版匯入才用）已改成動態載入的獨立分塊，約 700 kB，不影響首次載入；把警告門檻放到它之上
  build: { chunkSizeWarningLimit: 800 },
  // e2e 用 vite preview：同樣要隔離、同樣的父頁 CSP，才和正式環境一致。
  // 開發伺服器不加 CSP：@vitejs/plugin-react 會插一段行內腳本（HMR 前置），script-src 會擋掉
  preview: { headers: { ...ISOLATION_HEADERS, "Content-Security-Policy": parentCsp() } },
}));
