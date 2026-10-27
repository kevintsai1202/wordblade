import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// 字幕燒錄與逐字高亮（spec §5.4、§5.18，D37：Canvas 2D 畫進合成器）：用假閘道轉錄 talk.mp4 得到字幕，
// 檢查預覽畫面的下方有字幕、換樣式畫面會變、Karaoke 會依時間上色、匯出的 MP4 也有字幕。
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const GATEWAY = "http://fake-gateway.test";
const OUT = path.join(import.meta.dirname, "..", "output", "e2e-captions");

/** 匯入 talk.mp4、放上 V1、用假閘道轉錄（"Hello world." 0～2 秒、"Again." 2.5～4 秒） */
async function transcribed(page: Page) {
  await page.addInitScript((url) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "t" }));
    localStorage.setItem("wordblade.consent.asr", "yes");
    localStorage.setItem("wordblade.exportToOpfs", "1");
  }, GATEWAY);
  await page.route(`${GATEWAY}/v1/asr`, (route) => route.fulfill({
    status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ transcript: "Hello world. Again.", audioDurationMs: 4000, turns: [
      { transcript: "Hello world.", startMs: 0, endMs: 2000, speaker: "A" },
      { transcript: "Again.", startMs: 2500, endMs: 4000, speaker: "A" },
    ] }),
  }));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  await page.locator('[data-tab="transcript"]').click();
  await expect(page.getByTestId("transcribe-start")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("transcribe-start").click();
  await expect(page.getByTestId("transcribe-status")).toContainText("3 words", { timeout: 20_000 });
}

/** 預覽畫面下方 30% 的像素（RGBA） */
async function band(page: Page): Promise<number[]> {
  return page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const p = document.createElement("canvas");
    p.width = 320;
    p.height = 180;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 320, 180);
    return Array.from(ctx.getImageData(0, 126, 320, 54).data);
  });
}

/** 兩組像素有明顯差異的點數 */
function changed(a: number[], b: number[]): number {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 90) n++;
  return n;
}

/** 播放頭移到 t 秒並等畫面穩定 */
async function seek(page: Page, t: number) {
  // 尺規 20 px／秒、左邊從 0 開始
  await page.locator(".ruler").click({ position: { x: 1 + t * 20, y: 5 } });
  await page.waitForTimeout(400);
}

test("字幕畫進預覽：關掉（Off）與描邊、底色塊的畫面不同；data-caption 是目前這段字幕", async ({ page }) => {
  test.setTimeout(90_000);
  await transcribed(page);
  await seek(page, 1);
  await expect(page.getByTestId("preview-canvas")).toHaveAttribute("data-caption", "Hello world.");
  await page.locator('[data-tab="style"]').click();
  await page.getByTestId("caption-preset").selectOption("none");
  await page.waitForTimeout(300);
  const off = await band(page);
  await page.getByTestId("caption-preset").selectOption("outline");
  await expect.poll(async () => changed(off, await band(page)), { timeout: 10_000 }).toBeGreaterThan(150);
  const outline = await band(page);
  await page.getByTestId("caption-preset").selectOption("box");
  await expect.poll(async () => changed(outline, await band(page)), { timeout: 10_000 }).toBeGreaterThan(150);
  await page.screenshot({ path: "output/ui-shots/captions-box.png" });
});

test("逐字高亮：開了 Karaoke（填色）同一個時間點的字幕顏色不同；講到後面的字時上色的範圍變大", async ({ page }) => {
  test.setTimeout(90_000);
  await transcribed(page);
  await page.locator('[data-tab="style"]').click();
  await seek(page, 0.3);
  const offEarly = await band(page);
  await page.getByTestId("caption-karaoke").selectOption("fill");
  await expect.poll(async () => changed(offEarly, await band(page)), { timeout: 10_000 }).toBeGreaterThan(20);
  const early = changed(offEarly, await band(page));
  // 1.7 秒：world 也講到了，上色的字比 0.3 秒時多
  await page.getByTestId("caption-karaoke").selectOption("off");
  await seek(page, 1.7);
  const offLate = await band(page);
  await page.getByTestId("caption-karaoke").selectOption("fill");
  await expect.poll(async () => changed(offLate, await band(page)), { timeout: 10_000 }).toBeGreaterThan(early);
  await page.screenshot({ path: "output/ui-shots/captions-karaoke.png" });
});

test("匯出的 MP4 也有字幕：同一格開字幕和關字幕的下方畫面不同", async ({ page }) => {
  test.setTimeout(120_000);
  await transcribed(page);
  mkdirSync(OUT, { recursive: true });
  /** 匯出一次並取 1 秒處下方 30% 的畫面（rgb24） */
  const exportBand = async (name: string): Promise<Buffer> => {
    await page.locator('[data-tab="export"]').click();
    await page.getByTestId("export-start").click();
    await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 60_000 });
    const b64 = await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
      const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const file = path.join(OUT, `${name}.mp4`);
    writeFileSync(file, Buffer.from(b64, "base64"));
    return spawnSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", file, "-frames:v", "1", "-vf", "crop=iw:ih*0.3:0:ih*0.7", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout as Buffer;
  };
  const withCaptions = await exportBand("with-captions");
  await page.locator('[data-tab="style"]').click();
  await page.getByTestId("caption-preset").selectOption("none");
  const without = await exportBand("without-captions");
  let n = 0;
  for (let i = 0; i < withCaptions.length; i += 3) if (Math.abs(withCaptions[i] - without[i]) + Math.abs(withCaptions[i + 1] - without[i + 1]) + Math.abs(withCaptions[i + 2] - without[i + 2]) > 90) n++;
  expect(n).toBeGreaterThan(200);
});
