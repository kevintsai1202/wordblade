import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

// 時間軸範圍選取（照字導字演）：Shift＋拖曳軌道以播放頭為錨點拉出範圍 → 動作列（Zoom／Effect／Delete／✕）；
// 「Effect」切到 Vibe 頁籤、範本蓋住整段範圍；Delete 剪掉範圍（Ctrl+Z 復原）；I／O 設入出點、Esc 取消。
const FIXTURES = path.join(import.meta.dirname, "fixtures");
/** 時間軸每秒幾像素（預設） */
const PX = 20;

/** 匯入 talk.mp4 並放上 V1 兩次（共 8 秒） */
async function twoClips(page: Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  for (let i = 0; i < 2; i++) await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
}

/** 時間軸總長（秒，30 fps 時間碼） */
async function editedSeconds(page: Page): Promise<number> {
  const code = (await page.locator(".transport").innerText()).match(/Edited\s+(\d+):(\d+):(\d+):(\d+)/)!;
  const [h, m, s, f] = code.slice(1).map(Number);
  return h * 3600 + m * 60 + s + f / 30;
}

/** 播放頭移到 t 秒 */
async function seek(page: Page, t: number) {
  await page.locator(".ruler").click({ position: { x: 1 + t * PX, y: 5 } });
}

/** 在 V1 軌道上 Shift＋拖曳到 t 秒（錨點是播放頭） */
async function shiftDragTo(page: Page, t: number) {
  const row = (await page.locator('.track-row[data-track-id="V1"]').boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(row.x + 1 + (t - 0.6) * PX, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + 1 + t * PX, row.y + row.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
}

test("Shift＋拖曳拉出範圍：Effect 加的範本蓋住整段範圍", async ({ page }) => {
  test.setTimeout(60_000);
  await twoClips(page);
  await seek(page, 1);
  await shiftDragTo(page, 3);
  await expect(page.getByTestId("range-overlay")).toBeVisible();
  const box = (await page.getByTestId("range-overlay").boundingBox())!;
  expect(box.width).toBeGreaterThan(2 * PX - 4);
  expect(box.width).toBeLessThan(2 * PX + 4);
  await page.getByTestId("range-effect").click();
  await expect(page.getByTestId("vibe-placement")).toContainText("selected range (2.0 s)");
  await page.locator('[data-template="box-ding"]').click();
  const chip = (await page.locator(".effect-chip").boundingBox())!;
  expect(chip.width).toBeGreaterThan(2 * PX - 4);
  expect(chip.width).toBeLessThan(2 * PX + 4);
  expect(Math.abs(chip.x - box.x)).toBeLessThan(3);
});

test("範圍按 Delete 剪掉（片子變短），Ctrl+Z 回來", async ({ page }) => {
  test.setTimeout(60_000);
  await twoClips(page);
  const before = await editedSeconds(page);
  await seek(page, 4);
  await shiftDragTo(page, 6);
  await expect(page.getByTestId("range-actions")).toBeVisible();
  await page.keyboard.press("Delete");
  await expect.poll(() => editedSeconds(page)).toBeCloseTo(before - 2, 1);
  await expect(page.getByTestId("range-overlay")).toHaveCount(0);
  await page.keyboard.press("Control+z");
  await expect.poll(() => editedSeconds(page)).toBeCloseTo(before, 1);
});

test("I／O 設範圍、Esc 取消", async ({ page }) => {
  test.setTimeout(60_000);
  await twoClips(page);
  await seek(page, 1);
  await page.keyboard.press("i");
  await seek(page, 2.5);
  await page.keyboard.press("o");
  const box = (await page.getByTestId("range-overlay").boundingBox())!;
  expect(box.width).toBeGreaterThan(1.5 * PX - 4);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("range-overlay")).toHaveCount(0);
});
