import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// 2D 範本的音效跟著特效走（spec §5.15、§5.7；開發者 2026-11-01 選定）：
// gaps.mp4 在 2～3.5 秒沒有聲音；在 2 秒放「box-ding」（0.45 秒響一聲 ding）→ 預覽有這個特效的音效、匯出的 2.3～3.3 秒有聲音；
// Inspector 把特效音量調成 0 → 匯出的同一段又變安靜。
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const OUT = path.join(import.meta.dirname, "..", "output", "e2e-effect-sound");

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

/** 檔案 [a, b) 秒的聲音 RMS（單聲道 48 kHz） */
function rms(file: string, a: number, b: number): number {
  const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", String(a), "-t", String(b - a), "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"]).stdout as Buffer;
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
  let sum = 0;
  for (const v of pcm) sum += (v / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, pcm.length));
}

test("2D 範本的音效跟著特效：預覽與匯出都有聲音，音量調成 0 就沒有", async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => { localStorage.setItem("wordblade.exportToOpfs", "1"); localStorage.setItem("wordblade.dev", "1"); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "gaps.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "gaps.mp4" }).dblclick();
  // 播放頭移到 2 秒（尺規 20 px／秒）
  await page.locator(".ruler").click({ position: { x: 1 + 2 * 20, y: 5 } });
  await openTab(page, "vibe");
  await page.locator('[data-template="box-ding"]').click();
  // 特效帶著音效（元件換成雜湊），預覽算好這個特效的音效
  await expect.poll(() => page.evaluate(() => {
    const p = (window as unknown as { __wordblade: { project: () => { effects: { params: { sounds?: { at: number }[] } }[] } } }).__wordblade.project();
    return (p.effects[0]?.params.sounds ?? []).map((s) => s.at);
  }), { timeout: 20_000 }).toEqual([0.45]);
  await expect(page.locator("canvas[data-fx-sounds]")).toHaveAttribute("data-fx-sounds", "1", { timeout: 20_000 });

  const loud = rms(await exportTo(page, "with-sound"), 2.3, 3.3);
  expect(loud).toBeGreaterThan(0.01);

  // Inspector：特效音量 0 → 沒聲音
  await openTab(page, "inspector");
  await page.getByTestId("effect-sound-gain").fill("0");
  await page.getByTestId("effect-sound-gain").blur();
  const quiet = rms(await exportTo(page, "muted"), 2.3, 3.3);
  expect(quiet).toBeLessThan(0.002);
});
