import { expect, test } from "@playwright/test";
import path from "node:path";

// 漸進式縮圖（D39，開發者 2026-10-28）：匯入時做第一層（每 10 秒），空檔再做第二層（每 2 秒）、第三層（每 0.5 秒），
// 存在 OPFS；時間軸影片片段顯示影格條；拖曳播放頭時影片還在跳轉就先畫縮圖。talk.mp4 只有 4 秒：三層各一段。
const FIXTURES = path.join(import.meta.dirname, "fixtures");

test("匯入後三層縮圖依序做好、影格條顯示；拖曳播放頭時先畫縮圖", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();

  // 沒在播放、沒有重工作：背景把第二、三層做完，影格條改用最細的一層
  const strip = page.locator('.track-row[data-track-id="V1"] .clip .filmstrip');
  await expect(strip).toHaveAttribute("data-thumb-tier", "2", { timeout: 30_000 });
  await expect(strip.locator("img").first()).toBeVisible();
  // OPFS 裡三層都有完成標記，第三層有 8 張（0～3.5 秒）
  const files = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("thumbs");
    const out: Record<string, string[]> = {};
    for await (const [key, dir] of (root as unknown as AsyncIterable<[string, FileSystemDirectoryHandle]>)) {
      for (const tier of ["t0", "t1", "t2"]) {
        const names: string[] = [];
        for await (const [name] of (await dir.getDirectoryHandle(tier)) as unknown as AsyncIterable<[string]>) names.push(name);
        out[`${key}/${tier}`] = names.sort();
      }
    }
    return out;
  });
  const tiers = Object.entries(files).map(([k, v]) => [k.split("/")[1], v] as const);
  expect(tiers.find(([t]) => t === "t0")![1]).toEqual(["0.jpg", "c0.done"]);
  expect(tiers.find(([t]) => t === "t1")![1]).toEqual(["0.jpg", "1.jpg", "c0.done"]);
  expect(tiers.find(([t]) => t === "t2")![1].filter((n) => n.endsWith(".jpg"))).toHaveLength(8);

  // 時間軸放大後格子變多（每格仍取最近的縮圖）
  const before = await strip.locator("img").count();
  await page.getByTitle("Zoom in").click();
  await page.getByTitle("Zoom in").click();
  await expect.poll(() => strip.locator("img").count()).toBeGreaterThan(before);
  await page.screenshot({ path: "output/ui-shots/filmstrip.png" });

  // 拖曳播放頭：按下時影片開始跳轉，這一格先畫縮圖
  const handle = (await page.getByTestId("playhead-handle").boundingBox())!;
  const ruler = (await page.locator(".ruler").boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 4);
  await page.mouse.down();
  await page.mouse.move(ruler.x + 150, handle.y + 4, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => page.getByTestId("preview-canvas").getAttribute("data-thumb-frames")).not.toBeNull();
});
