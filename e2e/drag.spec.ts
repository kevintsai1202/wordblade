import { expect, test, type Locator, type Page } from "@playwright/test";

// 時間軸拖曳：移動疊加軌片段、拖出點修邊（V1 漣漪補位）、Ctrl+Z 復原
/** 從元素上某個水平位置拖到相對位移 dx */
async function dragBy(page: Page, el: Locator, xRatio: number, dx: number) {
  const box = (await el.boundingBox())!;
  const x = box.x + box.width * xRatio;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y, { steps: 4 });
  await page.mouse.move(x + dx, y, { steps: 4 });
  await page.mouse.up();
}

/** 元素的 left（像素數字） */
async function leftOf(el: Locator): Promise<number> {
  return parseFloat(await el.evaluate((n) => (n as HTMLElement).style.left));
}

test("拖曳移動與修邊", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?demo=1");

  // V2 的子母畫面片段（起點 20 秒、每秒 20 像素 → left 400）往右拖 100 像素＝5 秒
  const pip = page.locator(".track-row.video").nth(0).locator(".clip").first();
  expect(await leftOf(pip)).toBe(400);
  await dragBy(page, pip, 0.5, 100);
  expect(await leftOf(pip)).toBe(500);

  // V1 第一個片段（0～60 秒）拖出點往左 200 像素＝10 秒 → 第二個片段補位到 50 秒（left 1000）
  const v1 = page.locator(".track-row.video").nth(1).locator(".clip");
  await dragBy(page, v1.first(), 0.999, -200);
  expect(await leftOf(v1.nth(1))).toBe(1000);

  // 兩次 Ctrl+Z 都復原
  await page.keyboard.press("Control+z");
  expect(await leftOf(v1.nth(1))).toBe(1200);
  await page.keyboard.press("Control+z");
  expect(await leftOf(pip)).toBe(400);
});
