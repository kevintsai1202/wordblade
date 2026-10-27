import { defineConfig } from "vite";

// 量測頁：samples/ 當靜態目錄（支援 Range 請求），bench-11min.mp4 直接用 /bench-11min.mp4 讀
export default defineConfig({
  publicDir: "../../samples",
  server: { port: 5199, strictPort: true },
});
