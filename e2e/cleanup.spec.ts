import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { transcribed } from "./helpers/transcribed";
import { openTab } from "./helpers/tabs";

// 一鍵去贅詞（spec §5.16）＋清除無聲片段（§5.16b）：共用確認清單——找出來、取消勾選一條、Remove selected 一次剪掉、Ctrl+Z 復原。
const FIXTURES = path.join(import.meta.dirname, "fixtures");

/** 時間軸總長（「Edited 00:00:04:00」）換成秒（30 fps） */
async function editedSeconds(page: Page): Promise<number> {
  const code = (await page.locator(".transport").innerText()).match(/Edited\s+(\d+):(\d+):(\d+):(\d+)/);
  if (!code) return NaN;
  const [h, m, s, f] = code.slice(1).map(Number);
  return h * 3600 + m * 60 + s + f / 30;
}

test("清除無聲片段：gaps.mp4 中間兩段 1.5 秒無聲 → 找到 2 段、全部剪掉、片子短約 2.4 秒；Ctrl+Z 回來", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "gaps.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "gaps.mp4" }).dblclick();
  await openTab(page, "transcript");
  // 音量包絡算好才找得到（沒有逐字稿也能用）
  await expect.poll(async () => {
    await page.getByTestId("find-pauses").click();
    return page.getByTestId("cleanup-item").count();
  }, { timeout: 20_000 }).toBe(2);
  await expect(page.getByTestId("cleanup-item").first()).toContainText("pause");
  const before = await editedSeconds(page);
  await page.getByTestId("cleanup-remove").click();
  // 每段 1.5 秒、前後各留 0.15 秒 → 各剪 1.2 秒
  await expect.poll(() => editedSeconds(page)).toBeCloseTo(before - 2.4, 0);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect.poll(() => editedSeconds(page)).toBeCloseTo(before, 1);
});

test("一鍵去贅詞：找到 um 與 Uh、取消勾選 Uh、只剪 um；逐字稿少了 um", async ({ page }) => {
  test.setTimeout(90_000);
  await transcribed(page, [
    { transcript: "So um we start.", startMs: 0, endMs: 2000 },
    { transcript: "Uh okay.", startMs: 2500, endMs: 4000 },
  ]);
  const transcript = page.getByTestId("transcript");
  await expect(transcript).toContainText("um");
  await page.getByTestId("find-fillers").click();
  const items = page.getByTestId("cleanup-item");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toContainText("um");
  await expect(items.nth(1)).toContainText("Uh");
  // 取消勾選 Uh
  await items.nth(1).locator('input[type="checkbox"]').uncheck();
  await expect(page.getByTestId("cleanup-remove")).toHaveText("Remove selected (1)");
  const before = await editedSeconds(page);
  await page.getByTestId("cleanup-remove").click();
  await expect(transcript.locator("[data-word-id]", { hasText: /^um$/ })).toHaveCount(0);
  await expect(transcript).toContainText("Uh");
  expect(await editedSeconds(page)).toBeLessThan(before);
  await page.screenshot({ path: "output/ui-shots/cleanup.png" });
});
