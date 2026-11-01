import { expect, test } from "@playwright/test";
import { openTab } from "./helpers/tabs";

// AI 重配音實機測試（spec §5.6，2026-11-01）：連真的閘道與 Fish Audio（免費模型），只在設了環境變數時跑：
//   pwsh scripts/sam/live-local.ps1 -E2E -Spec e2e/revoice-live.spec.ts
// 範例專案（2 分鐘、有逐字稿）→ 框 20～24 秒 → Re-voice 改一句話 → Fish 生成 → 時間軸多一條 AI 聲音的軌、素材庫有 voice-*.wav。
const gateway = process.env.WORDBLADE_LIVE_GATEWAY;
const token = process.env.WORDBLADE_LIVE_TOKEN;
/** 尺規每秒幾像素（預設縮放） */
const PX = 20;

test.skip(!gateway || !token, "沒有設 WORDBLADE_LIVE_GATEWAY／WORDBLADE_LIVE_TOKEN");

test("重配音實機：範例專案框一段 → Fish 生成 → Voice 軌 → 匯出", async ({ page }) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(([url, tok]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    localStorage.setItem("wordblade.consent.voice", "yes");
    localStorage.setItem("wordblade.exportToOpfs", "1");
  }, [gateway!, token!]);
  await page.goto("/");
  await page.getByTestId("load-sample").click();
  await expect(page.locator('.track-row[data-track-id="V1"] .clip').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 120_000 });

  // Shift＋拖曳選 20～24 秒
  await page.locator(".ruler").click({ position: { x: 1 + 20 * PX, y: 5 } });
  const row = (await page.locator('.track-row[data-track-id="V1"]').boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(row.x + 1 + 20 * PX, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + 1 + 24 * PX, row.y + row.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.getByTestId("range-revoice").click();
  const text = page.getByTestId("revoice-text");
  console.log(`原本的字：${await text.inputValue()}`);
  await text.fill("Next, I'll open the env file and paste my key.");
  const t0 = Date.now();
  await page.getByTestId("revoice-generate").click();
  await expect(page.locator('[data-testid="revoice-item"], [data-testid="revoice-error"]').first()).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId("revoice-error")).toHaveCount(0);
  console.log(`重配音：${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  await page.screenshot({ path: "output/ui-shots/revoice-live.png" });

  // 只取出 AI 聲音的 WAV（素材庫裡 voice-*.wav）存檔，人工聽；整支 2 分鐘匯出要 10 分鐘以上，這裡不做
  const wav = await page.evaluate(async () => {
    const hook = (window as unknown as { __wordblade?: { project: () => { media: { name?: string; handleKey?: string }[] } } }).__wordblade;
    const m = hook?.project().media.find((x) => x.name?.startsWith("voice-"));
    return m?.name ?? null;
  });
  console.log(`AI 聲音素材：${wav}`);
  expect(wav).toMatch(/^voice-.*\.wav$/);
});
