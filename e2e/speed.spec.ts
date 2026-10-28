import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// 片段變速（spec §5.20，P1-6）：選 V1 片段 → Inspector 設倍數 → 時間軸變短／變長、連動的 A1 一起變 → 匯出的長度跟著變、
// 聲音保持音高（talk.mp4 的 440 Hz 正弦波：上升過零次數＝440 × 秒數；不保持音高的話 2 倍會變 880 Hz）→ Ctrl+Z 回來。
// 這補上 plan-10-31 ⑥「匯出 WSOLA 的聽感」的自動驗證；預覽的 preservesPitch 在 Playwright 量不到音高，不在這裡驗。
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const OUT = path.join(import.meta.dirname, "..", "output", "e2e-speed");

/** 時間軸總長（秒，30 fps 時間碼） */
async function editedSeconds(page: Page): Promise<number> {
  const code = (await page.locator(".transport").innerText()).match(/Edited\s+(\d+):(\d+):(\d+):(\d+)/)!;
  const [h, m, s, f] = code.slice(1).map(Number);
  return h * 3600 + m * 60 + s + f / 30;
}

/** 匯出（OPFS）並存成檔案 */
async function exportTo(page: Page, name: string): Promise<string> {
  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 90_000 });
  const b64 = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.mp4`);
  writeFileSync(file, Buffer.from(b64, "base64"));
  return file;
}

/** 檔案長度（秒） */
function duration(file: string): number {
  return Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout.trim());
}

/** 聲音的上升過零次數（單聲道 48 kHz） */
function zeroCrossings(file: string): number {
  const raw = spawnSync("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"]).stdout as Buffer;
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
  let n = 0;
  for (let i = 1; i < pcm.length; i++) if (pcm[i - 1] < 0 && pcm[i] >= 0) n++;
  return n;
}

/** 匯入 talk.mp4、放上 V1（連動 A1）、選 V1 片段、開 Inspector */
async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem("wordblade.exportToOpfs", "1"));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  await page.locator('.track-row[data-track-id="V1"] .clip').first().click();
  await openTab(page, "inspector");
  await expect(page.getByTestId("clip-inspector")).toBeVisible();
}

for (const { speed, seconds } of [{ speed: 2, seconds: 2 }, { speed: 0.5, seconds: 8 }]) {
  test(`變速 ${speed}×：時間軸 ${seconds} 秒、A1 一起變、匯出長度對且 440 Hz 不變調；Ctrl+Z 回來`, async ({ page }) => {
    test.setTimeout(150_000);
    await setup(page);
    const v1Width = (await page.locator('.track-row[data-track-id="V1"] .clip').first().boundingBox())!.width;
    await page.locator(`[data-speed="${speed}"]`).click();
    await expect.poll(() => editedSeconds(page)).toBeCloseTo(seconds, 1);
    // 連動的 A1 片段寬度和 V1 一樣跟著變
    const a1 = (await page.locator('.track-row[data-track-id="A1"] .clip').first().boundingBox())!.width;
    expect(a1).toBeCloseTo(v1Width / speed, -1);

    const file = await exportTo(page, `speed-${speed}`);
    expect(duration(file)).toBeGreaterThan(seconds - 0.1);
    expect(duration(file)).toBeLessThan(seconds + 0.15);
    // 保持音高：每秒仍約 440 次（容許 5%）
    const rate = zeroCrossings(file) / seconds;
    expect(rate).toBeGreaterThan(440 * 0.95);
    expect(rate).toBeLessThan(440 * 1.05);

    await page.locator("body").click({ position: { x: 5, y: 5 } });
    await page.keyboard.press("Control+z");
    await expect.poll(() => editedSeconds(page)).toBeCloseTo(4, 1);
  });
}
