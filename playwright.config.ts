import { defineConfig } from "@playwright/test";

// 介面測試：React 跑在瀏覽器（網頁版 Engine），先建置再用 vite preview 起靜態伺服器
export default defineConfig({
  testDir: "e2e",
  use: { baseURL: "http://localhost:4173" },
  webServer: {
    command: "pnpm build && pnpm preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
