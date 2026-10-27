import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// 局部放大（spec §5.19）：選 V1 片段 → Zoom 頁籤 Pick region → 在預覽拉框（左邊紅色色條附近，倍率 4）→
// 預覽在停留期間紅色佔大半、推進前是原畫面；匯出的 MP4 也放大；Ctrl+Z 回到原畫面。
// talk.mp4 是 testsrc2：7 條直色條（每條約 0.143 寬），最左是紅色；左上角是時間碼，所以框放在它下方。
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const OUT = path.join(import.meta.dirname, "..", "output", "e2e-zoom");

/** 預覽畫面紅色像素的比例 */
async function redRatio(page: Page): Promise<number> {
  return page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const p = document.createElement("canvas");
    p.width = 160;
    p.height = 90;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 160, 90);
    const d = ctx.getImageData(0, 0, 160, 90).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 170 && d[i + 1] < 80 && d[i + 2] < 80) n++;
    return n / (160 * 90);
  });
}

/** 播放頭移到 t 秒（尺規 20 px／秒） */
async function seek(page: Page, t: number) {
  await page.locator(".ruler").click({ position: { x: 1 + t * 20, y: 5 } });
  await page.waitForTimeout(400);
}

test("局部放大：拉框後預覽放大、匯出也放大、Ctrl+Z 回到原畫面", async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => localStorage.setItem("wordblade.exportToOpfs", "1"));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();

  // 選 V1 的片段，開 Zoom 頁籤
  await page.locator('[data-tab="zoom"]').click();
  await expect(page.getByTestId("zoom-hint")).toBeVisible();
  await page.locator('.track-row[data-track-id="V1"] .clip').first().click();
  await seek(page, 1);
  const unzoomed = await redRatio(page);
  expect(unzoomed).toBeLessThan(0.25);

  // Pick region：從 (0, 0.18) 拉到 (0.25, 0.43) → 倍率 4、取 x 0～0.25（紅色條約佔 57%）
  await page.getByTestId("zoom-pick").click();
  const overlay = page.getByTestId("zoom-overlay");
  const box = (await overlay.boundingBox())!;
  await page.mouse.move(box.x + 2, box.y + box.height * 0.18);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.43, { steps: 6 });
  await page.mouse.up();
  await expect(overlay).toHaveCount(0);
  await expect(page.getByTestId("zoom-key")).toHaveCount(2);

  // 停留期間（1～3 秒）放大；推進前（0.2 秒）是原畫面
  await seek(page, 2);
  await expect.poll(() => redRatio(page), { timeout: 10_000 }).toBeGreaterThan(0.45);
  await page.screenshot({ path: "output/ui-shots/zoom.png" });
  await seek(page, 0.2);
  await expect.poll(() => redRatio(page), { timeout: 10_000 }).toBeLessThan(0.25);

  // 匯出的 MP4 也放大（2 秒那一格）
  await page.locator('[data-tab="export"]').click();
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 60_000 });
  const b64 = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, "zoom.mp4");
  writeFileSync(file, Buffer.from(b64, "base64"));
  const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", "2", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout as Buffer;
  let red = 0;
  for (let i = 0; i < raw.length; i += 3) if (raw[i] > 170 && raw[i + 1] < 80 && raw[i + 2] < 80) red++;
  expect(red / (raw.length / 3)).toBeGreaterThan(0.45);

  // 復原：回到原畫面
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await seek(page, 2);
  await expect.poll(() => redRatio(page), { timeout: 10_000 }).toBeLessThan(0.25);
});
