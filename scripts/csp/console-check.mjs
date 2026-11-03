// 父頁 CSP 除錯：開 vite preview 的首頁，印出 console 錯誤與 CSP 違規（先 pnpm build；用法 node scripts/csp/console-check.mjs [網址]）
import { chromium } from "@playwright/test";
const url = process.argv[2] ?? "http://localhost:4173/";
const browser = await chromium.launch();
const page = await browser.newPage();
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[${m.type()}] ${m.text()}`); });
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForTimeout(3000);
console.log("import-media 按鈕數：", await page.getByTestId("import-media").count());
await browser.close();
