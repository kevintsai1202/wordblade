import { expect, test } from "@playwright/test";
import { openTab } from "./helpers/tabs";

// 麥克風錄音（spec §5.18，2026-11-01）：Chromium 的假麥克風（一直響的嗶聲）錄 2 秒 → 解碼成 WAV → 放上對白軌（A1）。
// Windows 錄音機退路要在 Windows 版、麥克風被擋的電腦上手動驗（scripts/recorder/sound-recorder.ps1 已手動跑過）。
test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });

test("錄音：假麥克風錄一段 → 長度與預聽 → 放上對白軌，素材是 voice-*.wav", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await openTab(page, "audio");
  await page.getByTestId("rec-start").click();
  await expect(page.getByTestId("rec-status")).toContainText("microphone");
  await page.waitForTimeout(2000);
  await page.getByTestId("rec-stop").click();
  await expect(page.getByTestId("rec-result")).toHaveAttribute("data-method", "mic", { timeout: 10_000 });
  const seconds = Number((await page.getByTestId("rec-result").locator(".muted").first().textContent())?.replace(/[^\d.]/g, ""));
  expect(seconds).toBeGreaterThan(1.2);
  await expect(page.getByTestId("rec-play")).toBeVisible();
  await page.getByTestId("rec-add").click();
  await expect(page.locator('[data-track-id="A1"] .clip')).toHaveCount(1, { timeout: 15_000 });
  await openTab(page, "media");
  await expect(page.locator(".media-item.audio .media-name")).toContainText(/^voice-.*\.wav$/);
});
