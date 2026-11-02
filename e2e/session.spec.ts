import { expect, test } from "@playwright/test";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// 自動存檔（P0 §5.13 第一步）：編輯後 2 秒存進這台電腦 → 重新整理後標題列出現「上次的工作」→ 還原 → 時間軸回來
// （網頁版的影片檔要重新匯入才看得到畫面，這裡只看專案內容）。示範專案沒編輯前不存。
const FIXTURES = path.join(import.meta.dirname, "fixtures");

/** 時間軸總長（秒） */
async function edited(page: import("@playwright/test").Page): Promise<number> {
  const code = (await page.locator(".transport").innerText()).match(/Edited\s+(\d+):(\d+):(\d+):(\d+)/)!;
  const [h, m, s, f] = code.slice(1).map(Number);
  return h * 3600 + m * 60 + s + f / 30;
}

test("編輯後自動存檔，重新整理可還原；示範專案不會蓋掉", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.getByTestId("restore-bar")).toHaveCount(0);
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  await page.locator('.track-row[data-track-id="V1"] .clip').first().click();
  await openTab(page, "inspector");
  await page.locator('[data-speed="2"]').click();
  await expect.poll(() => edited(page)).toBeCloseTo(2, 1);
  await page.waitForTimeout(2600);

  await page.reload();
  await expect(page.getByTestId("restore-bar")).toContainText("2 clips");
  // 載入示範專案（還沒編輯）不會蓋掉上次的工作
  await page.goto("/?demo=1");
  await page.waitForTimeout(2600);
  await page.goto("/");
  await page.getByTestId("restore-session").click();
  await expect(page.getByTestId("restore-bar")).toHaveCount(0);
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);
  await expect.poll(() => edited(page)).toBeCloseTo(2, 1);
  await expect(page.locator(".media-item", { hasText: "talk.mp4" })).toHaveCount(1);
  // 網頁版：用檔案選擇器匯入的檔案重新整理後拿不回來 → 標成離線、預覽畫 Media Offline 卡、出現重新連結（2026-11-02）
  await expect(page.getByTestId("missing-media")).toContainText("talk.mp4");
  await expect(page.getByTestId("preview-canvas")).toHaveAttribute("data-offline", "1");
});
