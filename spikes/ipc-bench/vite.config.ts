import { defineConfig } from "vite";

// 量測頁：打包成 dist/（Tauri 的 frontendDist）。場景程式共用 ../export-bench/src/scene3d.ts，所以允許讀上一層。
export default defineConfig({
  build: { target: "esnext", outDir: "dist", emptyOutDir: true },
  server: { fs: { allow: [".."] } },
});
