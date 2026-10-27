import { defineConfig } from "@playwright/test";

// 介面測試：React 跑在瀏覽器（網頁版 Engine），先建置再用 vite preview 起靜態伺服器。
// 預設 4173；被別的程式佔用時用環境變數 WORDBLADE_E2E_PORT 換（實機 ASR 測試的閘道 CORS 只放行 4173，換 port 時不跑那支）。
const port = Number(process.env.WORDBLADE_E2E_PORT ?? 4173);

export default defineConfig({
  testDir: "e2e",
  use: { baseURL: `http://localhost:${port}` },
  webServer: {
    command: `pnpm build && pnpm preview --port ${port} --strictPort`,
    url: `http://localhost:${port}`,
    reuseExistingServer: false,
    // 機器忙（其他專案的 vite、MCP 服務）時建置會慢到 1～2 分鐘，多留一點
    timeout: 300_000,
  },
});
