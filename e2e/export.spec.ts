import { expect, test, type Page } from "@playwright/test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

// MP4 匯出（spec §5.4）：網頁版把 V1＋A1 的影片加一個 2D 特效匯出成 MP4（e2e 寫進 OPFS，不開存檔對話框），
// 再把檔案拿出來用 ffprobe／ffmpeg 檢查：長度、解析度、有聲音、特效有畫進去、特效以外的畫面和原片一樣。
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const OUT = path.join(import.meta.dirname, "..", "output", "e2e-export");

/** 從 OPFS 的 exports/ 讀出檔案（base64） */
async function readExport(page: Page, name: string): Promise<Buffer> {
  const b64 = await page.evaluate(async (n) => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    const bytes = new Uint8Array(await (await (await dir.getFileHandle(n)).getFile()).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  }, name);
  return Buffer.from(b64, "base64");
}

/** ffprobe 讀串流資訊 */
function probe(file: string): { duration: number; streams: Record<string, string>[] } {
  const json = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height,sample_rate,channels", "-of", "json", file], { encoding: "utf8" }));
  return { duration: Number(json.format.duration), streams: json.streams };
}

/** 某個時間的畫面和原片同一時間的 PSNR（dB；越高越像） */
function psnrAt(file: string, original: string, t: number): number {
  // ffmpeg 的統計寫在 stderr
  const out = spawnSync("ffmpeg", ["-v", "info", "-ss", String(t), "-i", file, "-ss", String(t), "-i", original, "-frames:v", "1", "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  const value = /average:([\d.]+|inf)/.exec(out)?.[1] ?? "0";
  return value === "inf" ? 100 : Number(value);
}

/** 某個時間的畫面裡，區域 [x0,x1)×[y0,y1) 中紅色像素（紅框的線）的數量 */
function redPixels(file: string, t: number, [x0, y0, x1, y1]: number[]): number {
  const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout as Buffer;
  const width = 320;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * width + x) * 3;
      if (raw[i] > 170 && raw[i + 1] < 90 && raw[i + 2] < 90) n++;
    }
  }
  return n;
}

/** 聲音的平均音量（dB） */
function meanVolume(file: string): number {
  const log = spawnSync("ffmpeg", ["-v", "info", "-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(log)?.[1] ?? "-999");
}

test("網頁版匯出：影片＋聲音＋2D 特效 → MP4，長度、解析度、聲音、畫面都對", async ({ page }) => {
  test.setTimeout(120_000);
  page.on("console", (m) => { if (m.type() === "error") console.log(`[console.error] ${m.text()}`); });
  await page.addInitScript(() => localStorage.setItem("wordblade.exportToOpfs", "1"));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  // 0 秒加一個「紅框＋叮」範本（2.5 秒）
  await page.locator('[data-tab="vibe"]').click();
  await page.locator('[data-template="box-ding"]').click();
  await expect(page.locator(".effect-chip")).toHaveCount(1);

  await page.locator('[data-tab="export"]').click();
  await expect(page.getByTestId("export-summary")).toContainText("320×180");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 90_000 });
  await expect(page.getByTestId("export-error")).toHaveCount(0);

  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, "export.mp4");
  writeFileSync(file, await readExport(page, "wordblade-export.mp4"));
  const info = probe(file);
  expect(info.duration).toBeGreaterThan(3.9);
  expect(info.duration).toBeLessThan(4.15);
  const video = info.streams.find((s) => s.codec_type === "video")!;
  expect(video).toMatchObject({ codec_name: "h264", width: 320, height: 180 });
  const audio = info.streams.find((s) => s.codec_type === "audio")!;
  expect(Number(audio.sample_rate)).toBe(48000);
  // 原片是 440 Hz 正弦波（約 -21 dB）：匯出後仍有聲音
  expect(meanVolume(file)).toBeGreaterThan(-30);
  // 特效區段（1 秒）：畫面中央多了紅框（原片同區域沒有紅色）
  const original = path.join(FIXTURES, "talk.mp4");
  const box = [100, 60, 220, 115];
  expect(redPixels(file, 1, box) - redPixels(original, 1, box)).toBeGreaterThan(80);
  // 特效結束後（3 秒）：和原片同一格（testsrc2 每格不同，差一格 PSNR 會掉到 20 以下；雜訊方塊壓縮後約 24 dB）
  expect(psnrAt(file, original, 3)).toBeGreaterThan(22);
  expect(psnrAt(file, original, 3)).toBeGreaterThan(psnrAt(file, original, 3 + 1 / 30) + 2);
});

test("匯出可以取消：進度條出現後按取消，回到可再匯出的狀態、OPFS 不留半成品", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => localStorage.setItem("wordblade.exportToOpfs", "1"));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  // 放六次、輸出 1080p，片子夠長（24 秒）來得及按取消
  for (let i = 0; i < 6; i++) await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  await page.locator('[data-tab="export"]').click();
  await page.getByTestId("export-preset").selectOption("1080p");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-progress")).toBeVisible();
  await page.getByTestId("export-cancel").click();
  await expect(page.getByTestId("export-start")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("export-error")).toHaveCount(0);
  const exists = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports", { create: true });
    try {
      await dir.getFileHandle("wordblade-export.mp4");
      return true;
    } catch {
      return false;
    }
  });
  expect(exists).toBe(false);
});

test("3D 場景也匯出：桌上螢幕範本的中段看得到木紋桌", async ({ page }) => {
  test.setTimeout(150_000);
  await page.addInitScript(() => localStorage.setItem("wordblade.exportToOpfs", "1"));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  await page.locator('[data-tab="vibe"]').click();
  await page.locator('[data-template="desk-reveal"]').click();
  await expect(page.locator(".effect-chip")).toHaveCount(1);
  await page.locator('[data-tab="export"]').click();
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 120_000 });
  await expect(page.getByTestId("export-status")).not.toContainText("skipped");

  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, "export-3d.mp4");
  writeFileSync(file, await readExport(page, "wordblade-export.mp4"));
  // 3D 範本 6 秒、影片 4 秒：成片 6 秒
  expect(probe(file).duration).toBeGreaterThan(5.9);
  /** 木紋色（偏橘的棕）像素比例 */
  const wood = (t: number) => {
    const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout as Buffer;
    let hit = 0;
    for (let i = 0; i < raw.length; i += 3) if (raw[i] > 70 && raw[i] > raw[i + 1] * 1.25 && raw[i + 1] > raw[i + 2] * 1.2 && raw[i] < 230) hit++;
    return hit / (raw.length / 3);
  };
  expect(wood(3)).toBeGreaterThan(0.1);
  // 開頭接回滿版：看不到桌子
  expect(wood(0)).toBeLessThan(0.02);
});
