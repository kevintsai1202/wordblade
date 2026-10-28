import { expect, test } from "@playwright/test";
import path from "node:path";

// 在時間軸尺規上按住左鍵拖曳播放頭（scrub）：播放頭跟著滑鼠走、播放中按下會先停、預覽畫面跟著更新
const FIXTURES = path.join(import.meta.dirname, "fixtures");

test("尺規拖曳播放頭並即時預覽", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);

  // 先播放，按下尺規要讓它停下來
  await page.getByTestId("play").click();
  const ruler = (await page.locator(".ruler").boundingBox())!;
  const y = ruler.y + ruler.height / 2;
  const timecode = page.getByTestId("preview-timecode");

  // 按在 0.5 秒（每秒 20 像素 → 10 像素）、拖到 2 秒、再到 3.5 秒；中途時間碼就要跟上
  await page.mouse.move(ruler.x + 10, y);
  await page.mouse.down();
  await expect(page.getByTestId("play")).toHaveText("▶");
  await expect(timecode).toHaveText("00:00:00:15");
  await page.mouse.move(ruler.x + 40, y, { steps: 6 });
  await expect(timecode).toHaveText("00:00:02:00");
  await page.mouse.move(ruler.x + 70, y, { steps: 6 });
  await expect(timecode).toHaveText("00:00:03:15");
  await page.mouse.up();

  // 放開後再移動滑鼠，播放頭不再跟著動
  await page.mouse.move(ruler.x + 20, y, { steps: 3 });
  await expect(timecode).toHaveText("00:00:03:15");

  // 預覽畫面已更新到拖到的位置（testsrc2 每格不同；畫面有內容即可）
  await expect.poll(async () => page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const probe = document.createElement("canvas");
    probe.width = 32;
    probe.height = 18;
    const ctx = probe.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 32, 18);
    const d = ctx.getImageData(0, 0, 32, 18).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
    return lit / (32 * 18);
  })).toBeGreaterThan(0.3);
});

/** 匯入 talk.mp4（4 秒）放上 V1 */
async function setup(page: import("@playwright/test").Page) {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);
}

/** 預覽的時間碼換成秒（30 fps） */
async function seconds(page: import("@playwright/test").Page): Promise<number> {
  const [h, m, s, f] = (await page.getByTestId("preview-timecode").innerText()).split(":").map(Number);
  return h * 3600 + m * 60 + s + f / 30;
}

// 開發者 2026-10-28：播放中可隨時介入——抓住尺規上的播放頭把手（或在軌道空白處按住）就停止播放，拖曳時浮出時間碼
test("播放中抓住播放頭把手拖曳：停止播放、跟著滑鼠走、浮出時間碼；空白軌道上按住也能拖", async ({ page }) => {
  await setup(page);
  await page.getByTestId("play").click();
  await expect.poll(() => seconds(page)).toBeGreaterThan(0.6);
  const handle = (await page.getByTestId("playhead-handle").boundingBox())!;
  const ruler = (await page.locator(".ruler").boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 4);
  await page.mouse.down();
  await expect(page.getByTestId("play")).toHaveText("▶");
  await page.mouse.move(ruler.x + 60, handle.y + 4, { steps: 8 });
  await expect(page.getByTestId("preview-timecode")).toHaveText("00:00:03:00");
  await expect(page.getByTestId("scrub-time")).toContainText("00:03:00");
  await page.mouse.up();
  await expect(page.getByTestId("scrub-time")).toHaveCount(0);
  // 停住：過一會兒時間碼不再前進
  await page.waitForTimeout(400);
  await expect(page.getByTestId("preview-timecode")).toHaveText("00:00:03:00");

  // 空的 A2 軌道上按住拖曳：播放頭跟著走
  const a2 = (await page.locator('.track-row[data-track-id="A2"]').boundingBox())!;
  await page.mouse.move(ruler.x + 20, a2.y + a2.height / 2);
  await page.mouse.down();
  await page.mouse.move(ruler.x + 50, a2.y + a2.height / 2, { steps: 5 });
  await expect(page.getByTestId("preview-timecode")).toHaveText("00:00:02:15");
  await page.mouse.up();
});

test("播放中點軌道空白處或按方向鍵：停在新位置，不會被播放迴圈拉回去", async ({ page }) => {
  await setup(page);
  const ruler = (await page.locator(".ruler").boundingBox())!;
  const a2 = page.locator('.track-row[data-track-id="A2"]');
  await page.getByTestId("play").click();
  await expect.poll(() => seconds(page)).toBeGreaterThan(0.3);
  // A2 是空的軌道：點在 3 秒處（每秒 20 像素）
  const box = (await a2.boundingBox())!;
  await page.mouse.click(ruler.x + 60, box.y + box.height / 2);
  await expect(page.getByTestId("play")).toHaveText("▶");
  await page.waitForTimeout(400);
  await expect(page.getByTestId("preview-timecode")).toHaveText("00:00:03:00");

  // 倒退播放中按 → ：停止並前進一格
  await page.keyboard.press("j");
  await expect.poll(() => seconds(page)).toBeLessThan(2.8);
  await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("play")).toHaveText("▶");
  const at = await seconds(page);
  await page.waitForTimeout(400);
  expect(await seconds(page)).toBe(at);
});
