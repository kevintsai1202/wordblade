import { expect, test } from "@playwright/test";

// 主畫面版面（D33）與基本剪輯：選片段 → Delete 漣漪刪除 → Ctrl+Z 復原；截圖存 output/ui-shots/ 供目視檢查
test("主畫面版面與刪除／復原", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?demo=1");

  // 四個區塊都在：標題列、預覽、編輯面板、時間軸
  await expect(page.locator(".title-bar")).toBeVisible();
  await expect(page.locator(".preview .frame")).toBeVisible();
  await expect(page.locator(".edit-panel .tabs")).toContainText("Transcript");
  await expect(page.locator(".timeline .track-row")).toHaveCount(5); // V2、V1、S1、A1、A2

  // 逐字稿頁籤列出由逐字稿算出的字幕；點第二段播放頭移過去
  const items = page.locator(".transcript li");
  await expect(items.first()).toContainText("Okay, next");
  await items.nth(1).click();
  await expect(page.locator(".transcript li.active")).toHaveCount(1);
  await page.screenshot({ path: "output/ui-shots/layout.png" });

  // 選 V1 的第一個片段並刪除：V1 剩一個片段，且它補位到 0
  const v1Clips = page.locator(".track-row.video").nth(1).locator(".clip");
  await expect(v1Clips).toHaveCount(2);
  await v1Clips.first().click();
  await page.keyboard.press("Delete");
  await expect(v1Clips).toHaveCount(1);
  await expect(v1Clips.first()).toHaveCSS("left", "0px");

  // Ctrl+Z 復原
  await page.keyboard.press("Control+z");
  await expect(v1Clips).toHaveCount(2);
});

// 區塊大小（開發者 2026-10-28）：拖分隔線改右側面板寬度、時間軸高度、軌道標頭寬度；重新整理後保留；雙擊回預設
test("拖分隔線調整區塊大小、重新整理後保留、雙擊回預設", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?demo=1");
  const width = async (sel: string) => (await page.locator(sel).boundingBox())!.width;
  const height = async (sel: string) => (await page.locator(sel).boundingBox())!.height;
  expect(await width(".edit-panel")).toBeCloseTo(380, -1);
  expect(await height(".timeline")).toBeCloseTo(300, -1);
  expect(await width(".track-headers")).toBeCloseTo(88, -1);

  /** 從分隔線中心拖一段距離 */
  const drag = async (testId: string, dx: number, dy: number) => {
    const b = (await page.getByTestId(testId).boundingBox())!;
    await page.mouse.move(b.x + b.width / 2, b.y + Math.min(b.height / 2, 20));
    await page.mouse.down();
    await page.mouse.move(b.x + b.width / 2 + dx, b.y + Math.min(b.height / 2, 20) + dy, { steps: 5 });
    await page.mouse.up();
  };
  await drag("split-panel", -120, 0);
  await drag("split-timeline", 0, -100);
  await drag("split-header", 40, 0);
  expect(await width(".edit-panel")).toBeCloseTo(500, -1);
  expect(await height(".timeline")).toBeCloseTo(400, -1);
  expect(await width(".track-headers")).toBeCloseTo(128, -1);

  await page.reload();
  await expect(page.locator(".edit-panel")).toBeVisible();
  expect(await width(".edit-panel")).toBeCloseTo(500, -1);
  expect(await height(".timeline")).toBeCloseTo(400, -1);
  expect(await width(".track-headers")).toBeCloseTo(128, -1);
  await page.screenshot({ path: "output/ui-shots/layout-resized.png" });

  await page.getByTestId("split-panel").dblclick();
  await page.getByTestId("split-timeline").dblclick();
  await page.getByTestId("split-header").dblclick();
  expect(await width(".edit-panel")).toBeCloseTo(380, -1);
  expect(await height(".timeline")).toBeCloseTo(300, -1);
  expect(await width(".track-headers")).toBeCloseTo(88, -1);
});

// 右側面板大類別＋子頁籤（開發者 2026-10-28）：特效分 2D／3D／Zoom／Mask／Sound，回到大類別時打開上次的子頁籤
test("右側面板：大類別與子頁籤、記住上次的子頁籤", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/?demo=1");
  await expect(page.locator(".tabs [data-group]")).toHaveText(["Media", "Transcript", "Effects", "Inspector", "AI Director", "Export"]);
  await page.locator('[data-group="effects"]').click();
  await expect(page.locator(".subtabs [data-tab]")).toHaveText(["2D", "3D", "Zoom", "Mask", "Sound", "Intro"]);
  // 2D 只有 2D 範本，3D 只有 3D 場景
  await expect(page.locator('[data-template="box-ding"]')).toBeVisible();
  await expect(page.locator('[data-template="desk-reveal"]')).toHaveCount(0);
  await page.locator('[data-tab="vibe3d"]').click();
  await expect(page.locator('[data-template="desk-reveal"]')).toBeVisible();
  await expect(page.locator('[data-template="box-ding"]')).toHaveCount(0);
  await page.screenshot({ path: "output/ui-shots/tabs-effects-3d.png" });
  // 換到別的大類別再回來：還是 3D
  await page.locator('[data-group="inspector"]').click();
  await expect(page.locator(".subtabs")).toHaveCount(0);
  await page.locator('[data-group="effects"]').click();
  await expect(page.locator('[data-tab="vibe3d"]')).toHaveClass(/active/);
});
