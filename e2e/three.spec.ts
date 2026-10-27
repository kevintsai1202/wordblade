import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

// 3D 場景（spec §5.8）：3D 插件在獨立的沙盒 iframe（three.js 在 Worker 的 OffscreenCanvas 上畫），V1 當格畫面貼在螢幕上。
// 「桌上螢幕」範本：區段中間看得到木紋桌（棕色），頭尾接回滿版（畫面＝原片）。e2e 是軟體算繪（SwiftShader），等久一點。
const FIXTURES = path.join(import.meta.dirname, "fixtures");

/** 預覽畫面裡「木紋色」（偏橘的棕）像素的比例 */
async function woodRatio(page: Page): Promise<number> {
  return page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const p = document.createElement("canvas");
    p.width = 160;
    p.height = 90;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 160, 90);
    const d = ctx.getImageData(0, 0, 160, 90).data;
    let hit = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      if (r > 70 && r > g * 1.25 && g > b * 1.2 && r < 230) hit++;
    }
    return hit / (160 * 90);
  });
}

test("桌上螢幕：3D 沙盒畫出木紋桌與播影片的螢幕，頭尾接回滿版", async ({ page }) => {
  test.setTimeout(90_000);
  page.on("console", (m) => { if (m.type() === "error") console.log(`[console.error] ${m.text()}`); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  // V1 放一段影片（testsrc2 彩色測試圖，4 秒）
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();

  // 3D 範本加在 0 秒（長 6 秒，比影片長）
  await page.locator('[data-tab="vibe"]').click();
  await page.locator('[data-template="desk-reveal"]').click();
  await expect(page.locator(".effect-chip")).toHaveCount(1);

  // 中間（2 秒）：看得到木紋桌
  await page.locator(".ruler").click({ position: { x: 40, y: 5 } });
  await expect.poll(() => woodRatio(page), { timeout: 60_000 }).toBeGreaterThan(0.1);
  // 螢幕上播的是影片（testsrc2 彩色）：畫面中央不是全黑
  await expect.poll(() => page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const p = document.createElement("canvas");
    p.width = 160;
    p.height = 90;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 160, 90);
    const d = ctx.getImageData(60, 30, 40, 20).data;
    let colorful = 0;
    for (let i = 0; i < d.length; i += 4) if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 60) colorful++;
    return colorful / (40 * 20);
  }), { timeout: 30_000 }).toBeGreaterThan(0.2);
  await page.screenshot({ path: "output/ui-shots/three-desk.png" });

  // 開頭（0 秒）：滿版，看不到桌子
  await page.locator(".ruler").click({ position: { x: 1, y: 5 } });
  await expect.poll(() => woodRatio(page), { timeout: 30_000 }).toBeLessThan(0.02);
  // 3D 有自己的沙盒 iframe，跨來源隔離還在
  await expect(page.locator('iframe[data-testid="plugin-sandbox-3d"]')).toHaveAttribute("sandbox", "allow-scripts");
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);
});

test("漂浮的板子：中段板子縮小、背景是攝影棚；Inspector 換背景", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  await page.locator('[data-tab="vibe"]').click();
  await page.locator('[data-template="board-float"]').click();
  await expect(page.locator(".effect-chip")).toHaveCount(1);

  /** 左上角（板子縮到 0.8 時露出背景）的平均顏色 */
  const corner = () => page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const p = document.createElement("canvas");
    p.width = 160;
    p.height = 90;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 160, 90);
    const d = ctx.getImageData(2, 2, 8, 6).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return [r / n, g / n, b / n];
  });
  // 中段（2 秒）：左上角是攝影棚的深灰藍（藍 ≥ 紅），不是影片
  await page.locator(".ruler").click({ position: { x: 40, y: 5 } });
  await expect.poll(async () => { const [r, , b] = await corner(); return b >= r && b > 20 && b < 140; }, { timeout: 60_000 }).toBe(true);
  // Inspector：背景換純色
  await page.locator(".effect-chip").click();
  await page.locator('[data-tab="inspector"]').click();
  await page.locator('[data-param="background"] select').selectOption("color");
  await expect.poll(async () => { const [r, g, b] = await corner(); return Math.abs(r - 32) < 8 && Math.abs(g - 32) < 8 && Math.abs(b - 32) < 8; }, { timeout: 30_000 }).toBe(true);
  await page.screenshot({ path: "output/ui-shots/three-board.png" });
});

test("吉祥物：走到目標框旁邊；拖目標框，吉祥物跟著換位置", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator('[data-tab="vibe"]').click();
  await page.locator('[data-template="mascot-point"]').click();
  const chip = page.locator(".effect-chip");
  await expect(chip).toHaveCount(1);

  /** 橘色（吉祥物）像素的數量與水平重心（0～1） */
  const orange = () => page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const p = document.createElement("canvas");
    p.width = 160;
    p.height = 90;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 160, 90);
    const d = ctx.getImageData(0, 0, 160, 90).data;
    let n = 0, sx = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] > 90 && d[i + 1] < 210 && d[i + 2] < 90) { n++; sx += (i / 4) % 160; }
    return { n, x: n ? sx / n / 160 : -1 };
  });
  // 3 秒：已經走到框（中心 x 0.6、寬 0.25）左邊，重心大約在 0.4 附近
  await page.locator(".ruler").click({ position: { x: 60, y: 5 } });
  await expect.poll(async () => (await orange()).n, { timeout: 60_000 }).toBeGreaterThan(30);
  const before = await orange();
  expect(before.x).toBeGreaterThan(0.3);
  expect(before.x).toBeLessThan(0.55);

  // 拖目標框往右 0.25：吉祥物跟著往右
  await chip.click();
  const overlay = page.getByTestId("box-overlay");
  const o = (await overlay.boundingBox())!;
  const frame = (await page.getByTestId("preview-canvas").boundingBox())!;
  await page.mouse.move(o.x + o.width / 2, o.y + o.height / 2);
  await page.mouse.down();
  await page.mouse.move(o.x + o.width / 2 + frame.width * 0.25, o.y + o.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await orange()).x, { timeout: 30_000 }).toBeGreaterThan(before.x + 0.15);
  await page.screenshot({ path: "output/ui-shots/three-mascot.png" });
});
