/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { samplesPlugin } from "./vite.samples";
import process from "node:process";
const host = process.env.TAURI_DEV_HOST;

/** 跨來源隔離（crossOriginIsolated，WASM 多執行緒與 JASSUB 要用，§5.21）：和 nginx（網頁版）、tauri.conf（Windows 版）同一組 */
const ISOLATION_HEADERS = { "Cross-Origin-Opener-Policy": "same-origin", "Cross-Origin-Embedder-Policy": "require-corp" };

// https://vite.dev/config/
export default defineConfig(() => ({
  plugins: [react(), samplesPlugin()],


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
  // e2e 用 vite preview：同樣要隔離，才和正式環境一致
  preview: { headers: ISOLATION_HEADERS },
}));
