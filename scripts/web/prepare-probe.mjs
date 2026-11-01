// 網頁版長片匯入的 prepare 量測（2026-11-01：使用者 5 小時 1080p 影片卡在 Preparing 0%）。
// 開網頁版 → 匯入指定影片（<input>，沒開專案、不複製）→ 每 5 秒印素材庫狀態，最多等 N 秒，並印 console 錯誤。
// 用法：node scripts/web/prepare-probe.mjs <影片> [網址，預設 http://localhost:4173/] [最多幾秒，預設 300]
import { chromium } from "@playwright/test";
const [file, url = "http://localhost:4173/", maxSec = "300"] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("console", (m) => { if (m.type() === "error") console.log(`[console] ${m.text().slice(0, 300)}`); });
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
await page.goto(url);
const t0 = Date.now();
const chooser = page.waitForEvent("filechooser");
await page.getByTestId("import-media").click();
await (await chooser).setFiles(file);
for (let s = 0; s <= Number(maxSec); s += 5) {
  const status = await page.locator(".media-item").first().innerText().catch(() => "(none)");
  console.log(`${((Date.now() - t0) / 1000).toFixed(0)}s ${status.replace(/\s+/g, " ")}`);
  if (!/Preparing|Importing|Reading/i.test(status) && s > 0) break;
  await page.waitForTimeout(5000);
}
await browser.close();
