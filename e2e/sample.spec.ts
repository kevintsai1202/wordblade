import { expect, test } from "@playwright/test";
import { openTab } from "./helpers/tabs";

// 範例專案（spec §5.22）：「Try the sample project」從靜態網站（public/sample/）載入預先算好的專案，
// 不用權杖、不呼叫 AI——對外連線全部擋掉也要能開、有字幕與特效、能匯出。
test("範例專案：離線也能開、有逐字稿與特效、可以匯出", async ({ page }) => {
  test.setTimeout(300_000);
  /** 擋掉的對外請求（應該一個都沒有） */
  const blocked: string[] = [];
  await page.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (route) => {
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript(() => localStorage.setItem("wordblade.exportToOpfs", "1"));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.getByTestId("load-sample").click();

  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);
  await expect(page.locator(".effect-chip")).toHaveCount(4);
  await openTab(page, "transcript");
  await expect(page.getByText("Hey everyone.", { exact: false }).first()).toBeVisible();
  // 示範狀態：沒編輯前不自動存
  expect(await page.evaluate(() => localStorage.getItem("wordblade.session"))).toBeNull();

  // 匯出整支（2 分鐘，含 2D／3D 特效）
  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 280_000 });
  await expect(page.getByTestId("export-status")).not.toContainText("skipped");
  expect(blocked).toEqual([]);
});
