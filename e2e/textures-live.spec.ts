import { expect, test } from "@playwright/test";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// 材質實機測試（spec §5.12，P1-14，2026-11-01）：連真的閘道與 Muse Image（每張約 US$0.01），只在設了環境變數時跑：
//   pwsh scripts/sam/live-local.ps1 -E2E -Spec e2e/textures-live.spec.ts
// 流程：產生「dark green chalkboard」與「worn oak planks」兩張材質 → 教室場景的牆、地板套上 → 截圖到 output/ui-shots/texture-live.png。
const gateway = process.env.WORDBLADE_LIVE_GATEWAY;
const token = process.env.WORDBLADE_LIVE_TOKEN;
const FIXTURES = path.join(import.meta.dirname, "fixtures");

test.skip(!gateway || !token, "沒有設 WORDBLADE_LIVE_GATEWAY／WORDBLADE_LIVE_TOKEN");

test("材質實機：Muse Image 產生兩張材質 → 套到教室的牆與地板 → 截圖", async ({ page }) => {
  test.setTimeout(300_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(([url, tok]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    localStorage.setItem("wordblade.consent.texture", "yes");
  }, [gateway!, token!]);
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();

  await openTab(page, "textures");
  for (const [i, prompt] of ["dark green chalkboard with chalk dust", "worn oak planks"].entries()) {
    const t0 = Date.now();
    await page.getByTestId("texture-description").fill(prompt);
    await page.getByTestId("texture-generate").click();
    await expect(page.getByTestId("texture-item")).toHaveCount(i + 1, { timeout: 120_000 });
    console.log(`材質「${prompt}」：${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  }
  await page.screenshot({ path: "output/ui-shots/texture-live-library.png" });

  await openTab(page, "vibe3d");
  await page.locator('[data-template="classroom-board"]').click();
  await page.locator(".effect-chip").click();
  await openTab(page, "inspector");
  await page.locator('[data-param="wallTexture"] [data-testid="param-texture"]').selectOption({ label: "dark green chalkboard with chalk dust" });
  await page.locator('[data-param="floorTexture"] [data-testid="param-texture"]').selectOption({ label: "worn oak planks" });
  await page.locator(".ruler").click({ position: { x: 60, y: 5 } });
  await page.waitForTimeout(4000);
  await page.getByTestId("preview-canvas").screenshot({ path: "output/ui-shots/texture-live.png" });
});
