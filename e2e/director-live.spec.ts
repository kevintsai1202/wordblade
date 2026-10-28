import { expect, test, type Locator } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// AI 導演實機（會呼叫真的 Muse ASR、Spark、Wonder、SAM，約 US$0.1）：由 scripts/sam/live-local.ps1 -E2E -Spec e2e/director-live.spec.ts 執行。
// 模擬短片 samples/demo-2min.mp4（有正確答案）：匯入 → AI 導演（沒有逐字稿先自動轉錄）→ 建議裡要有蓋到假金鑰時間的 mask、蓋到重講的 cut
// → 採用那條 mask（真的跑 SAM）與 cut → 截圖。環境變數 WORDBLADE_LIVE_GATEWAY、WORDBLADE_LIVE_TOKEN；沒設就跳過。
const gateway = process.env.WORDBLADE_LIVE_GATEWAY;
const token = process.env.WORDBLADE_LIVE_TOKEN;
const SAMPLE = path.join(import.meta.dirname, "..", "samples", "demo-2min.mp4");
const truth = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "samples", "demo-2min.truth.json"), "utf8"));

test.skip(!gateway || !token, "needs WORDBLADE_LIVE_GATEWAY and WORDBLADE_LIVE_TOKEN");

/** 找一條和 [a, b] 重疊的某種建議 */
async function overlapping(rows: Locator, kind: string, a: number, b: number): Promise<Locator | null> {
  const list = rows.locator(`[data-kind="${kind}"]`);
  for (let i = 0; i < (await list.count()); i++) {
    const row = list.nth(i);
    const s = Number(await row.getAttribute("data-start"));
    const e = Number(await row.getAttribute("data-end"));
    if (s < b && e > a) return row;
  }
  return null;
}

test("實機：AI 導演找到假金鑰與重講，採用遮罩與剪", async ({ page }) => {
  test.setTimeout(420_000);
  await page.addInitScript(([url, tok]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    for (const k of ["director", "sam", "vibe", "plane3d", "asr"]) localStorage.setItem(`wordblade.consent.${k}`, "yes");
  }, [gateway!, token!]);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(SAMPLE);
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 60_000 });
  await page.locator(".media-item", { hasText: "demo-2min" }).dblclick();

  await openTab(page, "director");
  await expect(page.getByTestId("director-ask")).toBeEnabled({ timeout: 120_000 });
  const t0 = Date.now();
  await page.getByTestId("director-ask").click();
  await expect(page.getByTestId("director-message")).toBeVisible({ timeout: 300_000 });
  console.log(`導演實機：${((Date.now() - t0) / 1000).toFixed(1)} 秒；${await page.getByTestId("director-message").innerText()}`);
  const rows = page.getByTestId("director-list");
  for (const row of await page.getByTestId("director-row").all()) console.log(`  ${await row.getAttribute("data-kind")} ${await row.getAttribute("data-start")}–${await row.getAttribute("data-end")} ${(await row.innerText()).replace(/\s+/g, " ")}`);
  const mask = await overlapping(rows, "mask", truth.apiKey.start, truth.apiKey.end);
  const cut = await overlapping(rows, "cut", truth.retake.start, truth.retake.end);
  expect(mask, "a mask suggestion over the fake API key").not.toBeNull();
  expect(cut, "a cut suggestion over the retake").not.toBeNull();

  // 採用遮罩（真的跑 SAM）與剪
  await mask!.getByTestId("director-adopt").click();
  await expect(mask!).toHaveAttribute("data-status", "applied", { timeout: 180_000 });
  await cut!.getByTestId("director-adopt").click();
  await expect(cut!).toHaveAttribute("data-status", "applied");
  await mask!.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "output/ui-shots/director-live.png" });
});
