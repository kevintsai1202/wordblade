import { expect, test } from "@playwright/test";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// 實機（會呼叫真的 Meta SAM 3.1 與 Muse Spark，約 US$0.05）：由 scripts/sam/live-local.ps1 -E2E 起好本機閘道與權杖後執行。
// 1. 遮罩：FOSDEM 演講片段 30～36 秒（I／O 設範圍）→ 找 person → 清單至少一個物件 → 截圖留目視檢查
// 2. AI 音效：一句描述 → 產生 → 加進素材庫
// 3. AI 配樂：4 小節 → 產生
// 環境變數：WORDBLADE_LIVE_GATEWAY、WORDBLADE_LIVE_TOKEN（只在行程裡）。沒設就跳過。
const gateway = process.env.WORDBLADE_LIVE_GATEWAY;
const token = process.env.WORDBLADE_LIVE_TOKEN;
const SAMPLE = path.join(import.meta.dirname, "..", "samples", "fosdem-covid-3min.mp4");

test.skip(!gateway || !token, "needs WORDBLADE_LIVE_GATEWAY and WORDBLADE_LIVE_TOKEN");

test("實機：SAM 遮罩、AI 音效、AI 配樂", async ({ page }) => {
  test.setTimeout(300_000);
  await page.addInitScript(([url, tok]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    localStorage.setItem("wordblade.consent.sam", "yes");
    localStorage.setItem("wordblade.consent.audio", "yes");
  }, [gateway!, token!]);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(SAMPLE);
  await expect(page.locator(".media-item", { hasText: "fosdem" })).toBeVisible({ timeout: 30_000 });
  await page.locator(".media-item", { hasText: "fosdem" }).dblclick();
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);

  // 範圍 30～36 秒：播放頭到 30 秒按 I、到 36 秒按 O
  const ruler = (await page.locator(".ruler").boundingBox())!;
  await page.mouse.click(ruler.x + 30 * 20 + 1, ruler.y + 5);
  await page.keyboard.press("i");
  await page.mouse.click(ruler.x + 36 * 20 + 1, ruler.y + 5);
  await page.keyboard.press("o");
  await expect(page.getByTestId("range-actions")).toBeVisible();
  await page.getByTestId("range-mask").click();
  await expect(page.getByTestId("mask-range")).toContainText("60 frames");
  await page.locator('[data-phrase="person"]').click();
  const t0 = Date.now();
  await page.getByTestId("mask-find").click();
  await expect(page.getByTestId("mask-message")).toBeVisible({ timeout: 180_000 });
  console.log(`SAM 實機：${((Date.now() - t0) / 1000).toFixed(1)} 秒；${await page.getByTestId("mask-message").innerText()}`);
  await expect(page.getByTestId("mask-row").first()).toBeVisible();
  await page.mouse.click(ruler.x + 32 * 20 + 1, ruler.y + 5);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "output/ui-shots/sam-live.png" });

  // AI 音效
  await openTab(page, "audio");
  await page.getByTestId("sound-description").fill("a soft whoosh for a slide transition");
  await page.getByTestId("sound-generate").click();
  await expect(page.getByTestId("sound-result").or(page.getByTestId("sound-error"))).toBeVisible({ timeout: 120_000 });
  console.log(`音效實機：${await page.getByTestId("sound-result").or(page.getByTestId("sound-error")).innerText()}`);
  await expect(page.getByTestId("sound-error")).toHaveCount(0);

  // AI 配樂
  await page.getByTestId("music-description").fill("calm lo-fi background for a coding tutorial");
  await page.getByTestId("music-bars").selectOption("4");
  await page.getByTestId("music-generate").click();
  await expect(page.getByTestId("music-result").or(page.getByTestId("music-error"))).toBeVisible({ timeout: 180_000 });
  console.log(`配樂實機：${await page.getByTestId("music-result").or(page.getByTestId("music-error")).innerText()}`);
  await expect(page.getByTestId("music-error")).toHaveCount(0);
  await page.screenshot({ path: "output/ui-shots/sound-live.png" });
});
