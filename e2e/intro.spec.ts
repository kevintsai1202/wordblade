import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// 一鍵片頭「翻頁式」（spec §5.23）：匯入幾張封面＋影片，Intro 頁籤填標題按 Generate →
// 時間軸開頭插入片頭（原本的影片往後移）；翻頁段看得到雙色調（偏藍紫）的封面，揭曉後畫面中央是標題方塊（藍）與白字；
// 預設有內建配樂（揭曉 4 秒、片頭 8 秒）：A3 每頁一聲翻頁＋上升音＋重擊、A2 一段配樂。Ctrl+Z 一次復原。
// e2e 是軟體算繪（SwiftShader），第一格建場景、上傳貼圖較慢，等久一點。
const FIXTURES = path.join(import.meta.dirname, "fixtures");

/** 在瀏覽器裡畫 n 張不同顏色的 PNG 封面（條紋讓亮度有變化，雙色調才看得出來） */
async function makeCovers(page: Page, n: number) {
  const list = await page.evaluate(async (count) => {
    const out: string[] = [];
    for (let i = 0; i < count; i++) {
      const c = new OffscreenCanvas(640, 360);
      const g = c.getContext("2d")!;
      g.fillStyle = `hsl(${(i * 360) / count}, 80%, 50%)`;
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = "rgba(255,255,255,0.7)";
      for (let x = 0; x < 640; x += 80) g.fillRect(x, 0, 30, 360);
      const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
      let s = "";
      for (const b of bytes) s += String.fromCharCode(b);
      out.push(btoa(s));
    }
    return out;
  }, n);
  return list.map((b64, i) => ({ name: `cover-${i + 1}.png`, mimeType: "image/png", buffer: Buffer.from(b64, "base64") }));
}

/** 預覽畫面某區域（160×90 座標）的像素統計：偏藍紫的比例、接近白的比例 */
async function stats(page: Page, x: number, y: number, w: number, h: number) {
  return page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement, r) => {
    const p = document.createElement("canvas");
    p.width = 160;
    p.height = 90;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 160, 90);
    const d = ctx.getImageData(r.x, r.y, r.w, r.h).data;
    let blue = 0;
    let white = 0;
    for (let i = 0; i < d.length; i += 4) {
      const [R, G, B] = [d[i], d[i + 1], d[i + 2]];
      if (B > 90 && B > R * 1.25 && B > G * 1.1) blue++;
      if (R > 200 && G > 200 && B > 200) white++;
    }
    const n = r.w * r.h;
    return { blue: blue / n, white: white / n };
  }, { x, y, w, h });
}

/** 點時間軸尺規跳到 t 秒（尺規預設每秒 20 px，同 three.spec） */
async function seek(page: Page, t: number) {
  await page.locator(".ruler").click({ position: { x: Math.max(1, t * 20), y: 5 } });
}

test("翻頁式片頭：插在開頭、翻頁段是雙色調封面、揭曉後是標題方塊與白字，Ctrl+Z 一次復原", async ({ page }) => {
  test.setTimeout(120_000);
  page.on("console", (m) => { if (m.type() === "error") console.log(`[console.error] ${m.text()}`); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  // 影片放上 V1，再匯入 8 張封面
  let chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(await makeCovers(page, 8));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });

  await openTab(page, "intro");
  await page.getByTestId("intro-title").fill("WORDBLADE");
  await page.getByTestId("intro-subtitle").fill("edit by words");
  await page.getByTestId("intro-generate").click();
  await expect(page.getByTestId("intro-notice")).toContainText("intro at the start");
  await expect(page.getByTestId("intro-notice")).toContainText("8.0 s");
  await expect(page.locator(".effect-chip")).toHaveCount(1);
  // 音效軌：16 頁各一聲＋上升音＋重擊；配樂軌一段
  await expect(page.locator('[data-track-id="A3"] .clip')).toHaveCount(18);
  await expect(page.locator('[data-track-id="A2"] .clip')).toHaveCount(1);

  // 翻頁段（3 秒）：畫面大半是雙色調封面（偏藍紫）
  await seek(page, 3);
  await expect.poll(async () => (await stats(page, 0, 0, 160, 90)).blue, { timeout: 60_000 }).toBeGreaterThan(0.25);
  await page.screenshot({ path: "output/ui-shots/intro-flip.png" });

  // 揭曉後（5 秒）：中央有藍色方塊與白字
  await seek(page, 5);
  await expect.poll(async () => {
    const s = await stats(page, 40, 33, 80, 24);
    return s.blue > 0.2 && s.white > 0.03;
  }, { timeout: 30_000 }).toBe(true);
  await page.screenshot({ path: "output/ui-shots/intro-title.png" });

  // 佔位圖進了素材庫
  await openTab(page, "media");
  await expect(page.locator(".media-item", { hasText: "intro-black.png" })).toHaveCount(1);

  // Ctrl+Z：整段片頭一次拿掉
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect(page.locator(".effect-chip")).toHaveCount(0);
  await expect(page.locator('[data-track-id="A3"] .clip')).toHaveCount(0);
});

/** 匯入影片放上 V1、匯入 8 張封面、在 Intro 頁籤產生片頭 */
async function setupIntro(page: Page) {
  let chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(await makeCovers(page, 8));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await openTab(page, "intro");
  await page.getByTestId("intro-title").fill("WORDBLADE");
  await page.getByTestId("intro-generate").click();
  await expect(page.getByTestId("intro-notice")).toContainText("intro at the start");
}

test("片頭也匯出：成片 12 秒，翻頁段是雙色調、揭曉後中央有藍方塊與白字、片頭有聲音", async ({ page }) => {
  test.setTimeout(240_000);
  await page.addInitScript(() => localStorage.setItem("wordblade.exportToOpfs", "1"));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await setupIntro(page);
  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 200_000 });
  await expect(page.getByTestId("export-status")).not.toContainText("skipped");

  // 從 OPFS 拿出成片
  const b64 = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  const out = path.join(import.meta.dirname, "..", "output", "e2e-export");
  mkdirSync(out, { recursive: true });
  const file = path.join(out, "export-intro.mp4");
  writeFileSync(file, Buffer.from(b64, "base64"));

  const duration = Number(spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).stdout);
  expect(duration).toBeGreaterThan(11.9);
  /** 某秒畫面縮成 160×90 後某區域的藍紫、白色比例 */
  const frameStats = (t: number, [x0, y0, x1, y1]: number[]) => {
    const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=160:90", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout as Buffer;
    let blue = 0;
    let white = 0;
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * 160 + x) * 3;
      const [R, G, B] = [raw[i], raw[i + 1], raw[i + 2]];
      if (B > 90 && B > R * 1.25 && B > G * 1.1) blue++;
      if (R > 200 && G > 200 && B > 200) white++;
    }
    const n = (x1 - x0) * (y1 - y0);
    return { blue: blue / n, white: white / n };
  };
  expect(frameStats(3, [0, 0, 160, 90]).blue).toBeGreaterThan(0.25);
  const title = frameStats(5, [40, 33, 120, 57]);
  expect(title.blue).toBeGreaterThan(0.2);
  expect(title.white).toBeGreaterThan(0.03);
  // 片頭 8 秒內有聲音（翻頁、上升音、重擊、配樂）
  const log = spawnSync("ffmpeg", ["-v", "info", "-t", "8", "-i", file, "-af", "volumedetect", "-vn", "-f", "null", "-"], { encoding: "utf8" }).stderr;
  expect(Number(/mean_volume: (-?[\d.]+) dB/.exec(log)?.[1] ?? "-999")).toBeGreaterThan(-35);
});
