import { expect, test } from "@playwright/test";

// 煙霧測試：網頁版建置後打得開，且選到網頁版 Engine
test("網頁版首頁顯示 WordBlade 並使用網頁版 Engine", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".title-bar .brand")).toHaveText("WordBlade");
  await expect(page.getByTestId("engine-kind")).toHaveText("Engine: web");
  // COOP／COEP 生效：跨來源隔離（JASSUB、WASM 多執行緒要用，§5.21）
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
});

test("網頁版 Try the sample project 載入範例專案", async ({ page }) => {
  await page.goto("/");
  await page.getByTestId("load-sample").click();
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);
  await expect(page.locator(".media-item[data-media-id]")).toHaveCount(1);
});
