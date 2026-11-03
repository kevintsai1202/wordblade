// 探測：Playwright 的 filechooser 事件能不能接住 window.showOpenFilePicker（決定網頁版選檔要不要改用 FS Access）
import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto("http://localhost:4173/");
const chooser = page.waitForEvent("filechooser", { timeout: 5000 }).then(() => "filechooser 事件有觸發").catch(() => "沒有 filechooser 事件");
const result = page.evaluate(() => window.showOpenFilePicker().then((h) => `拿到 ${h.length} 個 handle：${h[0]?.name}`).catch((e) => `失敗：${e.name}`));
const c = await chooser;
console.log(c);
if (c.startsWith("filechooser")) { const fc = await page.waitForEvent("filechooser").catch(() => null); }
console.log(await Promise.race([result, new Promise((r) => setTimeout(() => r("逾時"), 6000))]));
await browser.close();
