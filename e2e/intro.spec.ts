import { expect, test, type Page } from "@playwright/test";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// 一鍵片頭「翻頁式」（spec §5.23）：匯入幾張封面＋影片，Intro 頁籤填標題按 Generate →
// 時間軸開頭插入片頭（原本的影片往後移）；翻頁段看得到雙色調（偏藍紫）的封面，揭曉後畫面中央是標題方塊（藍）與白字；Ctrl+Z 一次復原。
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
  await expect(page.locator(".effect-chip")).toHaveCount(1);

  // 翻頁段（1.8 秒）：畫面大半是雙色調封面（偏藍紫）
  await seek(page, 1.8);
  await expect.poll(async () => (await stats(page, 0, 0, 160, 90)).blue, { timeout: 60_000 }).toBeGreaterThan(0.25);
  await page.screenshot({ path: "output/ui-shots/intro-flip.png" });

  // 揭曉後（4.5 秒）：中央有藍色方塊與白字
  await seek(page, 4.5);
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
});
