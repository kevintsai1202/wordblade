import { expect, test, type Page } from "@playwright/test";

// 2D 特效（spec §5.7）：沙盒（沒有 same-origin 的 iframe → Worker → 原專案的直譯器）畫出範本，疊在預覽上。
// 空專案也能用：特效本身撐開成片長度。驗：框線範本在目標框附近畫出紅色、文字範本畫出白字，跨來源隔離還在。

/** 預覽畫布某個區域（0～1 的框）裡符合條件的像素比例 */
async function ratioIn(page: Page, box: { x: number; y: number; w: number; h: number }, kind: "red" | "white"): Promise<number> {
  return page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement, { box, kind }) => {
    const probe = document.createElement("canvas");
    probe.width = 320;
    probe.height = 180;
    const ctx = probe.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 320, 180);
    const x0 = Math.round(box.x * 320), y0 = Math.round(box.y * 180), w = Math.round(box.w * 320), h = Math.round(box.h * 180);
    const d = ctx.getImageData(x0, y0, w, h).data;
    let hit = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
      if (kind === "red" ? r > 180 && g < 90 && b < 90 : r > 200 && g > 200 && b > 200) hit++;
    }
    return hit / (w * h);
  }, { box, kind });
}

test("內建範本在沙盒裡畫出來並疊在預覽上", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  // 沙盒的錯誤多半只出現在主控台：失敗時一起印出來
  page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log(`[console.${m.type()}] ${m.text()}`); });
  page.on("pageerror", (e) => console.log(`[pageerror] ${e.message}`));
  await page.goto("/");
  await page.locator('[data-tab="vibe"]').click();

  // 紅框範本：目標框在畫面中央（寬 0.3、高 0.2），播放頭移到 1.5 秒（框線已畫完）
  await page.locator('[data-template="box-ding"]').click();
  // 第一次要等沙盒啟動、內建元件驗證完；失敗時頁籤會顯示錯誤
  await expect(page.locator('.effect-chip, [data-testid="vibe-error"]')).toHaveCount(1, { timeout: 15_000 });
  await expect(page.getByTestId("vibe-error")).toHaveCount(0);
  await expect(page.locator(".effect-chip")).toHaveCount(1);
  await page.locator(".ruler").click({ position: { x: 30, y: 5 } });
  await expect.poll(() => ratioIn(page, { x: 0.33, y: 0.38, w: 0.34, h: 0.24 }, "red"), { timeout: 10_000 }).toBeGreaterThan(0.02);
  // 框的外面沒有紅色（畫在目標框附近，不是整個畫面）
  expect(await ratioIn(page, { x: 0, y: 0, w: 0.25, h: 0.25 }, "red")).toBe(0);

  // 文字範本（打字機）：播放頭只能到成片終點（紅框結束的 2.5 秒），加在那裡；移到 4 秒（區段內 1.5 秒）時中央有白字
  await page.locator(".ruler").click({ position: { x: 60, y: 5 } });
  await page.locator('[data-template="title-typewriter"]').click();
  await expect(page.locator(".effect-chip")).toHaveCount(2);
  await page.locator(".ruler").click({ position: { x: 80, y: 5 } });
  await expect(page.getByTestId("preview-timecode")).toHaveText("00:00:04:00");
  await expect.poll(() => ratioIn(page, { x: 0.2, y: 0.4, w: 0.6, h: 0.2 }, "white"), { timeout: 10_000 }).toBeGreaterThan(0.01);

  // 沙盒是沒有 same-origin 的 iframe，跨來源隔離沒被破壞
  await expect(page.locator('iframe[data-testid="plugin-sandbox"]')).toHaveAttribute("sandbox", "allow-scripts");
  expect(await page.evaluate(() => self.crossOriginIsolated)).toBe(true);

  // 刪除特效（選取後 Delete）、Ctrl+Z 復原
  await page.keyboard.press("Delete");
  await expect(page.locator(".effect-chip")).toHaveCount(1);
  await page.keyboard.press("Control+z");
  await expect(page.locator(".effect-chip")).toHaveCount(2);
});

test("特效的拖曳、Inspector 改參數、預覽上拖目標框", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.locator('[data-tab="vibe"]').click();
  await page.locator('[data-template="box-ding"]').click();
  const chip = page.locator(".effect-chip");
  await expect(chip).toHaveCount(1, { timeout: 15_000 });

  // 時間軸：特效標籤往右拖 40 像素＝2 秒
  const c = (await chip.boundingBox())!;
  await page.mouse.move(c.x + c.width / 2, c.y + c.height / 2);
  await page.mouse.down();
  await page.mouse.move(c.x + c.width / 2 + 20, c.y + c.height / 2, { steps: 4 });
  await page.mouse.move(c.x + c.width / 2 + 40, c.y + c.height / 2, { steps: 4 });
  await page.mouse.up();
  await expect(chip).toHaveCSS("left", "40px");
  await page.keyboard.press("Control+z");
  await expect(chip).toHaveCSS("left", "0px");

  // Inspector：選取後改「進場」為 fly（一筆可復原的編輯），目標框的中心 X 顯示 0.5
  await chip.click();
  await page.locator('[data-tab="inspector"]').click();
  await expect(page.getByTestId("inspector")).toBeVisible();
  await expect(page.locator('[data-param="box.cx"] input')).toHaveValue("0.5");
  const motion = page.locator('[data-param="motion"] select');
  await motion.selectOption("draw");
  await expect(motion).toHaveValue("draw");

  // 預覽上的目標框：往左上拖，Inspector 的中心 X 跟著變小；紅框改畫在左上
  await page.locator(".ruler").click({ position: { x: 30, y: 5 } });
  await chip.click();
  const overlay = page.getByTestId("box-overlay");
  await expect(overlay).toBeVisible();
  const o = (await overlay.boundingBox())!;
  const frame = (await page.getByTestId("preview-canvas").boundingBox())!;
  await page.mouse.move(o.x + o.width / 2, o.y + o.height / 2);
  await page.mouse.down();
  await page.mouse.move(o.x + o.width / 2 - frame.width * 0.15, o.y + o.height / 2 - frame.height * 0.15, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Number(await page.locator('[data-param="box.cx"] input').inputValue())).toBeLessThan(0.4);
});
