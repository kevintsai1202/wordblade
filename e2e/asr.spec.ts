import { expect, test } from "@playwright/test";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// Muse ASR（spec §5.2）：用假的閘道（page.route 攔 /v1/asr）走完整流程——同意 → 抽 16 kHz 單聲道 WAV → 送出 →
// 依音量包絡重建詞級時間 → 寫進專案（字幕出現）→ Ctrl+Z 復原。不連真的閘道、不花錢。
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const GATEWAY = "https://fake-gateway.test";

test("轉錄：送出的是 16 kHz 單聲道 WAV，回來的 turns 變成字幕，可以復原", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript((url) => localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "test-token" })), GATEWAY);
  /** 收到的請求：WAV 檔頭資訊與授權標頭 */
  const seen: { auth: string | null; riff: boolean; channels: number; rate: number; bits: number; seconds: number }[] = [];
  await page.route(`${GATEWAY}/v1/asr`, async (route) => {
    const req = route.request();
    const body = req.postDataBuffer()!;
    const at = body.indexOf("RIFF");
    seen.push({
      auth: req.headers()["authorization"] ?? null,
      riff: at >= 0,
      channels: body.readUInt16LE(at + 22),
      rate: body.readUInt32LE(at + 24),
      bits: body.readUInt16LE(at + 34),
      seconds: body.readUInt32LE(at + 40) / 2 / body.readUInt32LE(at + 24),
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "access-control-allow-origin": "*" },
      body: JSON.stringify({
        transcript: "Hello world. Again.",
        audioDurationMs: 4000,
        turns: [
          { transcript: "Hello world.", startMs: 0, endMs: 2000, speaker: "0" },
          { transcript: "Again.", startMs: 2500, endMs: 4000, speaker: "0" },
        ],
      }),
    });
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();

  await openTab(page, "transcript");
  await expect(page.getByTestId("transcribe-start")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("transcribe-start").click();
  // 第一次要同意上傳
  await expect(page.getByTestId("transcribe-consent")).toBeVisible();
  await page.getByTestId("transcribe-consent").getByRole("button", { name: "Agree and continue" }).click();
  await expect(page.getByTestId("transcribe-status")).toContainText("3 words", { timeout: 30_000 });
  await expect(page.getByTestId("transcribe-error")).toHaveCount(0);

  // 送出的是 Muse 要的格式：16 kHz、單聲道、16-bit，長度約 4 秒，帶權杖
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ auth: "Bearer test-token", riff: true, channels: 1, rate: 16000, bits: 16 });
  expect(seen[0].seconds).toBeGreaterThan(3.9);
  expect(seen[0].seconds).toBeLessThan(4.1);

  // 字幕出現（逐字稿頁籤依字幕分段列出）
  await expect(page.locator(".transcript li")).not.toHaveCount(0);
  await expect(page.locator(".transcript")).toContainText("Hello world.");
  await expect(page.locator(".transcript")).toContainText("Again.");
  await page.screenshot({ path: "output/ui-shots/asr.png" });

  // 復原：字幕消失
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect(page.locator(".transcript li")).toHaveCount(0);
});

test("閘道忙（503）會自動重試；其他錯誤顯示訊息", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript((url) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "test-token" }));
    localStorage.setItem("wordblade.consent.asr", "yes");
  }, GATEWAY);
  let calls = 0;
  await page.route(`${GATEWAY}/v1/asr`, async (route) => {
    calls++;
    const headers = { "access-control-allow-origin": "*" };
    if (calls === 1) await route.fulfill({ status: 503, headers, contentType: "application/json", body: "{\"error\":\"asr-busy\"}" });
    else if (calls === 2) await route.fulfill({ status: 200, headers, contentType: "application/json", body: JSON.stringify({ transcript: "Hi.", audioDurationMs: 4000, turns: [{ transcript: "Hi.", startMs: 0, endMs: 4000, speaker: null }] }) });
    else await route.fulfill({ status: 400, headers, contentType: "application/json", body: "{\"error\":\"bad-audio\"}" });
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await openTab(page, "transcript");
  // 素材準備好（音量包絡算完）按鈕才能按
  await expect(page.getByTestId("transcribe-start")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("transcribe-start").click();
  await expect(page.getByTestId("transcribe-status")).toContainText("1 words", { timeout: 30_000 });
  expect(calls).toBe(2);
  // 再轉一次：閘道回 400 → 顯示錯誤
  await page.getByTestId("transcribe-start").click();
  await expect(page.getByTestId("transcribe-error")).toContainText("400");
});
