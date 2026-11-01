import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// 11/1 補的兩個 2D 範本（粒子迸發 confetti-burst、數字跳動 count-up）：加到時間軸、預覽有畫出來，
// 截兩個時間點的預覽到 output/ui-shots/，人工確認位置與外觀（粒子散開而不是一團、數字在框中央、最後停在 100%）。
const FIXTURES = path.join(import.meta.dirname, "fixtures");

/** 播放頭移到 t 秒（尺規 20 px／秒）並等特效畫格回來 */
async function seek(page: Page, t: number) {
  await page.locator(".ruler").click({ position: { x: 1 + t * 20, y: 5 } });
  await page.waitForTimeout(800);
}

for (const id of ["confetti-burst", "count-up"]) {
  test(`範本 ${id}：預覽畫得出來（截圖）`, async ({ page }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.goto("/");
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("import-media").click();
    await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
    await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
    await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
    await seek(page, 1);
    await openTab(page, "vibe");
    await page.locator(`[data-template="${id}"]`).click();
    const canvas = page.locator(".preview canvas").first();
    for (const dt of [0.5, 1.6]) {
      await seek(page, 1 + dt);
      await canvas.screenshot({ path: `output/ui-shots/template-${id}-${dt}.png` });
    }
  });
}
