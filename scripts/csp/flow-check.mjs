// 父頁 CSP 除錯：在 vite preview（帶 CSP）上點音效範本與範例專案，印出 CSP 違規、頁面錯誤與 console 錯誤。
// 先 pnpm build 並開 vite preview --port 4173；用法 node scripts/csp/flow-check.mjs
import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
page.on("console", (m) => { if (m.type() === "error") console.log(`[console] ${m.text().slice(0, 300)}`); });
page.on("pageerror", (e) => console.log(`[pageerror] ${e.message.slice(0, 300)}`));
await page.addInitScript(() => document.addEventListener("securitypolicyviolation", (e) => console.error(`CSP ${e.effectiveDirective} ${e.blockedURI} ${e.sourceFile}:${e.lineNumber}`)));
await page.goto("http://localhost:4173/");
console.log("== 音效範本");
await page.locator(`[data-group="${process.env.GROUP ?? "effects"}"]`).click(); if (await page.locator("[data-tab=\"audio\"]").count()) await page.locator("[data-tab=\"audio\"]").click();
await page.locator('[data-template="pop"]').click().catch((e) => console.log("點不到範本", e.message));
await page.waitForTimeout(3000);
console.log("sound-result：", await page.getByTestId("sound-result").count());
console.log("== 範例專案");
await page.getByTestId("load-sample").click();
await page.waitForTimeout(8000);
await browser.close();
