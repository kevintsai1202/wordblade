import { expect, test } from "@playwright/test";
import { transcribed } from "./helpers/transcribed";

// 逐字稿面板（spec §5.1 改字即剪、§4 改字）：點字跳播放頭、Shift 選一段、Delete 剪掉（時間軸變短）、雙擊改字、Ctrl+Z 復原。
// 用假閘道轉錄 talk.mp4："Hello world." 0～2 秒、"Again." 2.5～4 秒。

/** 時間軸總長（「Edited 00:00:04:00」） */
async function edited(page: import("@playwright/test").Page): Promise<string> {
  return (await page.locator(".transport").innerText()).match(/Edited\s+([\d:]+)/)?.[1] ?? "";
}

test("選字刪除：時間軸剪掉那段、字不見了；Ctrl+Z 回來", async ({ page }) => {
  test.setTimeout(90_000);
  await transcribed(page);
  const transcript = page.getByTestId("transcript");
  await expect(transcript).toContainText("Hello world.");
  const before = await edited(page);

  // 點 world：播放頭跳過去（時間碼不再是 0）
  await transcript.locator('[data-word-id]', { hasText: "world." }).click();
  await expect(page.locator(".transport")).not.toContainText("00:00:00:00");
  // Shift 點 Again.：選 world. 到 Again.
  await transcript.locator('[data-word-id]', { hasText: "Again." }).click({ modifiers: ["Shift"] });
  await expect(transcript.locator(".word.selected")).toHaveCount(2);
  await page.keyboard.press("Delete");

  await expect(transcript).not.toContainText("world.");
  await expect(transcript).not.toContainText("Again.");
  await expect(transcript).toContainText("Hello");
  // 只剪字：影片片段還在（時間軸只是變短，不是整個片段被刪）
  await expect(page.locator(".clip")).not.toHaveCount(0);
  expect(await edited(page)).not.toBe(before);

  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect(transcript).toContainText("world.");
  await expect(transcript).toContainText("Again.");
  expect(await edited(page)).toBe(before);
});

test("雙擊改字：一個字改成兩個字，字幕跟著變；Ctrl+Z 回來", async ({ page }) => {
  test.setTimeout(90_000);
  await transcribed(page);
  const transcript = page.getByTestId("transcript");
  await transcript.locator('[data-word-id]', { hasText: "Hello" }).dblclick();
  const input = page.getByTestId("word-edit");
  await expect(input).toHaveValue("Hello");
  await input.fill("Hi there");
  await input.press("Enter");
  await expect(transcript).toContainText("Hi there world.");
  // 預覽的字幕也換了（播放頭在 0 秒，第一段字幕）
  await expect(page.getByTestId("preview-canvas")).toHaveAttribute("data-caption", /Hi there world\./);
  await page.screenshot({ path: "output/ui-shots/transcript-edit.png" });

  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect(transcript).toContainText("Hello world.");
});
