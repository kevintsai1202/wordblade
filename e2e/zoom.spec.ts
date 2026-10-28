import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// 局部放大（spec §5.19、D38，照字導字演）：Shift＋拖曳時間軸選範圍 → 🔍 Zoom 建立一段放大 → 預覽上的放大框
// 拖角落縮成 4 倍、拖到左邊紅色色條 → 中段放大、範圍外原畫面；＋Keyframe 在 3 秒加路徑點並只移動那一點 → 放大範圍沿路徑移動；
// 匯出也放大；放大條按 Delete 刪掉、Ctrl+Z 回來。talk.mp4 是 testsrc2：7 條直色條（每條約 0.143 寬），最左是紅色。
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const OUT = path.join(import.meta.dirname, "..", "output", "e2e-zoom");
const PX = 20;

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

/** 播放頭移到 t 秒 */
async function seek(page: Page, t: number) {
  await page.locator(".ruler").click({ position: { x: 1 + t * PX, y: 5 } });
  await page.waitForTimeout(400);
}

/** 拖一個元素：位移用預覽畫面的比例 */
async function dragBy(page: Page, selector: string, fx: number, fy: number) {
  const frame = (await page.getByTestId("zoom-edit").boundingBox())!;
  const el = (await page.locator(selector).boundingBox())!;
  const x = el.x + el.width / 2;
  const y = el.y + el.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + fx * frame.width, y + fy * frame.height, { steps: 8 });
  await page.mouse.up();
}

test("局部放大：選範圍建立、調框、路徑點、匯出、刪除與復原", async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => localStorage.setItem("wordblade.exportToOpfs", "1"));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();

  // Shift＋拖曳選 0.5～3.5 秒 → 🔍 Zoom
  await seek(page, 0.5);
  const row = (await page.locator('.track-row[data-track-id="V1"]').boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(row.x + 1 + 3 * PX, row.y + 8);
  await page.mouse.down();
  await page.mouse.move(row.x + 1 + 3.5 * PX, row.y + 8, { steps: 4 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.getByTestId("range-zoom").click();
  await expect(page.locator(".zoomband")).toHaveCount(1);
  await expect(page.getByTestId("zoom-edit")).toBeVisible();
  await expect(page.getByTestId("zoom-row")).toHaveCount(1);

  // 拖角落：框寬 0.5 → 0.25（4 倍）；再把框拖到左上（中心 0.125, 0.3）
  await seek(page, 2);
  await dragBy(page, '[data-testid="zoom-resize"]', -0.125, -0.125);
  await expect(page.locator(".zoom-scale")).toContainText("×4.0");
  await dragBy(page, '[data-testid="zoom-frame"]', -0.4, -0.2);
  await page.getByTestId("zoom-done").click();
  await expect(page.getByTestId("zoom-edit")).toHaveCount(0);

  // 中段（2 秒）放大到紅色色條；範圍前（0.2 秒）是原畫面
  await expect.poll(() => redRatio(page), { timeout: 10_000 }).toBeGreaterThan(0.45);
  await seek(page, 0.2);
  await expect.poll(() => redRatio(page), { timeout: 10_000 }).toBeLessThan(0.25);
  await seek(page, 1.6);
  // 影片跳轉完才有畫面：等到紅色出現再記下來
  await expect.poll(() => redRatio(page), { timeout: 10_000 }).toBeGreaterThan(0.45);
  const atStart = await redRatio(page);

  // 匯出的 MP4：1.6 秒那一格也放大（加路徑點之前，這時框還停在紅色色條上）
  await openTab(page, "export");
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
  const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", "1.6", "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout as Buffer;
  let red = 0;
  for (let i = 0; i < raw.length; i += 3) if (raw[i] > 170 && raw[i + 1] < 80 && raw[i + 2] < 80) red++;
  expect(red / (raw.length / 3)).toBeGreaterThan(0.45);

  // 調整：3 秒加路徑點、只把那一點往右移 → 2.6 秒時放大範圍已經往右走，紅色變少
  await openTab(page, "zoom");
  await page.getByTestId("zoom-adjust").click();
  await seek(page, 3);
  await page.getByTestId("zoom-add-point").click();
  await expect(page.locator(".zoompt")).toHaveCount(2);
  await dragBy(page, '[data-testid="zoom-frame"]', 0.5, 0);
  await page.getByTestId("zoom-done").click();
  await seek(page, 2.6);
  await expect.poll(() => redRatio(page), { timeout: 10_000 }).toBeLessThan(atStart - 0.15);
  await page.screenshot({ path: "output/ui-shots/zoom-path.png" });

  // 放大條：點選後按 Delete 刪掉；Ctrl+Z 回來
  await page.locator(".zoomband").click({ position: { x: 30, y: 6 } });
  await page.keyboard.press("Delete");
  await expect(page.locator(".zoomband")).toHaveCount(0);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect(page.locator(".zoomband")).toHaveCount(1);
});
