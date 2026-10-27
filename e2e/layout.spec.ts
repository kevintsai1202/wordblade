import { expect, test } from "@playwright/test";

// 主畫面版面（D33）與基本剪輯：選片段 → Delete 漣漪刪除 → Ctrl+Z 復原；截圖存 output/ui-shots/ 供目視檢查
test("主畫面版面與刪除／復原", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?demo=1");

  // 四個區塊都在：標題列、預覽、編輯面板、時間軸
  await expect(page.locator(".title-bar")).toBeVisible();
  await expect(page.locator(".preview .frame")).toBeVisible();
  await expect(page.locator(".edit-panel .tabs")).toContainText("Transcript");
  await expect(page.locator(".timeline .track-row")).toHaveCount(5); // V2、V1、S1、A1、A2

  // 逐字稿頁籤列出由逐字稿算出的字幕；點第二段播放頭移過去
  const items = page.locator(".transcript li");
  await expect(items.first()).toContainText("Okay, next");
  await items.nth(1).click();
  await expect(page.locator(".transcript li.active")).toHaveCount(1);
  await page.screenshot({ path: "output/ui-shots/layout.png" });

  // 選 V1 的第一個片段並刪除：V1 剩一個片段，且它補位到 0
  const v1Clips = page.locator(".track-row.video").nth(1).locator(".clip");
  await expect(v1Clips).toHaveCount(2);
  await v1Clips.first().click();
  await page.keyboard.press("Delete");
  await expect(v1Clips).toHaveCount(1);
  await expect(v1Clips.first()).toHaveCSS("left", "0px");

  // Ctrl+Z 復原
  await page.keyboard.press("Control+z");
  await expect(v1Clips).toHaveCount(2);
});
