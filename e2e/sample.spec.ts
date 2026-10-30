import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// 範例專案（spec §5.22）：「Try the sample project」從靜態網站（public/sample/）載入預先算好的專案，
// 不用權杖、不呼叫 AI——對外連線全部擋掉也要能開、有字幕與特效、能匯出。
test("範例專案：離線也能開、有逐字稿與特效、可以匯出", async ({ page }) => {
  test.setTimeout(1_500_000);
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

  // V1：剪掉重講後的多段；導演 plain 風格（docs/plan-10-30-director3.md）沒有特效，改看放大條
  await expect.poll(() => page.locator('.track-row[data-track-id="V1"] .clip').count()).toBeGreaterThan(1);
  await expect.poll(() => page.locator(".zoomband").count()).toBeGreaterThan(2);
  await openTab(page, "transcript");
  await expect(page.getByText("meeting notes", { exact: false }).first()).toBeVisible();
  // 示範狀態：沒編輯前不自動存
  expect(await page.evaluate(() => localStorage.getItem("wordblade.session"))).toBeNull();

  // 匯出整支（2 分鐘，含 2D／3D 特效）
  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 1_400_000 });
  await expect(page.getByTestId("export-status")).not.toContainText("skipped");
  expect(blocked).toEqual([]);

  // 成片存一份到 output/sample-export.mp4（人工檢查 AI 剪出來的樣子）
  const b64 = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  mkdirSync(path.join(import.meta.dirname, "..", "output"), { recursive: true });
  writeFileSync(path.join(import.meta.dirname, "..", "output", "sample-export.mp4"), Buffer.from(b64, "base64"));
});
