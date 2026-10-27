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
