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
    localStorage.setItem("wordblade.dev", "1");
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

  // 存下 AI 聲音與它在時間軸的位置，給 scripts/tts/revoice-compare.ps1 做「原始 vs 重配」試聽檔
  const out = await page.evaluate(async () => {
    type M = { id: string; name?: string; path?: string; handleKey?: string };
    const hook = (window as unknown as { __wordblade: { project: () => { media: M[]; voiceovers?: { start: number; end: number; mediaId: string; text: string }[] }; fileBytes: (k: string) => Promise<Uint8Array | null> } }).__wordblade;
    const p = hook.project();
    const vo = p.voiceovers![0];
    const m = p.media.find((x) => x.id === vo.mediaId)!;
    let bytes: number[] | null = null;
    if (m.handleKey) { const b = await hook.fileBytes(m.handleKey); if (b) bytes = Array.from(b); }
    if (!bytes && m.path) bytes = Array.from(new Uint8Array(await (await fetch(m.path)).arrayBuffer()));
    return { start: vo.start, end: vo.end, text: vo.text, bytes };
  });
  expect(out.bytes?.length ?? 0).toBeGreaterThan(1000);
  const { mkdirSync, writeFileSync } = await import("node:fs");
  mkdirSync("output/revoice", { recursive: true });
  writeFileSync("output/revoice/voice.wav", Buffer.from(out.bytes!));
  writeFileSync("output/revoice/voice.json", JSON.stringify({ start: out.start, end: out.end, text: out.text }));
});
