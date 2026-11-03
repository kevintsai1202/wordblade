// 抓黑客松活動頁（JS 動態載入）的文字，存成 output/hackathon-details.txt，方便對照提交規定。
// 用法：node scripts/web/fetch-hackathon-details.mjs [網址]
import { chromium } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";

/** 要抓的頁面 */
const url = process.argv[2] ?? "https://cerebralvalley.ai/e/meta-ai-developer-hackathon/details";
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(url, { waitUntil: "networkidle", timeout: 60_000 });
// 等「Loading...」消失
await page.waitForFunction(() => !document.body.innerText.includes("Loading..."), null, { timeout: 30_000 }).catch(() => {});
const text = await page.evaluate(() => document.body.innerText);
mkdirSync("output", { recursive: true });
writeFileSync("output/hackathon-details.txt", text);
console.log(`已存 output/hackathon-details.txt（${text.length} 字）`);
await browser.close();
