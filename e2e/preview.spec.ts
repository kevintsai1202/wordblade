import { expect, test, type Page } from "@playwright/test";

// 預覽合成器（D24）：示範專案用 samples/ 的英文錄課片。samples/ 不進版控，沒有影片就略過。

/** 預覽畫布上非黑色像素的比例（把 WebGL 畫布畫到 2D 畫布再讀） */
async function litRatio(page: Page): Promise<number> {
  return page.evaluate(() => {
    const src = document.querySelector<HTMLCanvasElement>("[data-testid=preview-canvas]")!;
    const c = document.createElement("canvas");
    c.width = 160;
    c.height = 90;
    const ctx = c.getContext("2d")!;
    ctx.drawImage(src, 0, 0, 160, 90);
    const data = ctx.getImageData(0, 0, 160, 90).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 60) lit++;
    return lit / (160 * 90);
  });
}

test("預覽畫出影片畫面，播放會推進播放頭", async ({ page, request }) => {
  const probe = await request.get("/samples/lecture-a.en.mp4", { headers: { Range: "bytes=0-1" } });
  test.skip(probe.status() !== 206, "samples/ 沒有示範影片（先跑 scripts/make-english-sample.mjs）");

  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?demo=1");

  // 暫停狀態下：畫面要有內容（錄課畫面不是全黑）
  await expect.poll(() => litRatio(page), { timeout: 15_000 }).toBeGreaterThan(0.2);
  await page.screenshot({ path: "output/ui-shots/preview.png" });

  // 拖到 65 秒（第二個 V1 片段），畫面仍有內容
  await page.locator(".transcript li").filter({ hasText: "Okay, next" }).nth(1).click();
  await expect.poll(() => litRatio(page), { timeout: 15_000 }).toBeGreaterThan(0.2);

  // Space 播放 1.5 秒後時間碼前進，再 Space 暫停後不再前進
  const timecode = page.getByTestId("preview-timecode");
  const before = await timecode.textContent();
  await page.keyboard.press("Space");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Space");
  const after = await timecode.textContent();
  expect(after).not.toBe(before);
  await page.waitForTimeout(500);
  expect(await timecode.textContent()).toBe(after);
});
