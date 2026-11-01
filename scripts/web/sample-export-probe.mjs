// 範例專案匯出的除錯（2026-11-01：sample.spec 按 Export 後 export-status 一直沒出現）：開範例 → 匯出 → 每 5 秒印狀態與 console 錯誤
// 用法：node scripts/web/sample-export-probe.mjs [網址，預設 http://localhost:4176/] [最多幾秒，預設 120]
import { chromium } from "@playwright/test";
const [url = "http://localhost:4176/", maxSec = "120"] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[${m.type()}] ${m.text().slice(0, 300)}`); });
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
await page.addInitScript(() => localStorage.setItem("wordblade.exportToOpfs", "1"));
await page.goto(url);
await page.getByTestId("load-sample").click();
await page.waitForTimeout(3000);
await page.locator('[data-group="export"]').click().catch(() => {});
const tab = page.locator('[data-tab="export"]');
if (await tab.count()) await tab.click();
await page.getByTestId("export-start").click({ timeout: 30_000 });
for (let s = 0; s <= Number(maxSec); s += 5) {
  const st = await page.locator(".export-tab").innerText().catch(() => "(no export tab)");
  console.log(`${s}s ${st.replace(/\s+/g, " ").slice(0, 160)}`);
  if (/Saved|error|failed/i.test(st) || (s > 10 && /Export MP4/.test(st))) break;
  await page.waitForTimeout(5000);
}
await browser.close();
