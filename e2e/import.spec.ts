import { expect, test, type Page } from "@playwright/test";
import path from "node:path";

// 素材庫（§5.13）網頁版：匯入（含不支援格式的提示）→ 背景準備（縮圖、波形）→ 拖到 V1／A2、雙擊加到結尾 →
// Ctrl+Z 只復原放置、素材還在 → 預覽畫得出匯入的影片 → 播放時 Web Audio 混音圖有輸出聲音。
const FIXTURES = path.join(import.meta.dirname, "fixtures");

/** 讀頁面上的混音圖診斷（src/audio/audioGraph.ts 掛在 window 上） */
function audioProbe(page: Page) {
  return page.evaluate(() => (window as { __wordbladeAudio?: () => { state: string; level: number } | null }).__wordbladeAudio?.() ?? null);
}

/** 把素材庫的一筆拖到某條軌道上的 x 位置（相對軌道左緣的像素） */
async function dragMediaTo(page: Page, name: string, trackId: string, xInTrack: number) {
  const item = page.locator(".media-item", { hasText: name });
  const from = (await item.boundingBox())!;
  const row = (await page.locator(`.track-row[data-track-id="${trackId}"]`).boundingBox())!;
  await page.mouse.move(from.x + 20, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + xInTrack / 2, row.y + row.height / 2, { steps: 5 });
  await page.mouse.move(row.x + xInTrack, row.y + row.height / 2, { steps: 5 });
  await page.mouse.up();
}

test("匯入素材、拖到時間軸、預覽與混音", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");

  // 空專案一開始就在素材頁籤；匯入四個檔案
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(["talk.mp4", "music.mp3", "card.png", "clip.mkv"].map((f) => path.join(FIXTURES, f)));

  // 三個可用的素材＋一個不支援的（MKV）提示改用 Windows 版
  await expect(page.locator(".media-item[data-media-id]")).toHaveCount(3);
  await expect(page.locator(".media-item.failed")).toContainText("Windows app");
  // 聲音分離（§5.14）只有 Windows 版：有聲音的素材（影片、音樂）各有一顆按鈕，網頁版停用並提示；圖片沒有
  const separate = page.getByTestId("media-separate");
  await expect(separate).toHaveCount(2);
  await expect(separate.first()).toBeDisabled();
  await expect(separate.first()).toHaveAttribute("title", "Available in the Windows app");
  await expect(page.locator(".media-item", { hasText: "card.png" }).getByTestId("media-separate")).toHaveCount(0);
  // 背景準備完成：沒有「Preparing」，影片與圖片有縮圖
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(".media-item", { hasText: "talk.mp4" }).locator("img")).toBeVisible();
  await expect(page.locator(".media-item", { hasText: "card.png" }).locator("img")).toBeVisible();

  // 影片拖到 V1：V1 一段、聲音拆到 A1 一段（帶波形）
  await dragMediaTo(page, "talk.mp4", "V1", 300);
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);
  await expect(page.locator('.track-row[data-track-id="A1"] .clip .waveform')).toHaveCount(1);

  // 圖片雙擊：接在 V1 結尾（4 秒處、每秒 20 像素 → left 80），長 5 秒
  await page.locator(".media-item", { hasText: "card.png" }).dblclick();
  const v1Clips = page.locator('.track-row[data-track-id="V1"] .clip');
  await expect(v1Clips).toHaveCount(2);
  await expect(v1Clips.nth(1)).toHaveCSS("left", "80px");
  await expect(v1Clips.nth(1)).toHaveCSS("width", "100px");

  // 配樂拖到 A2 的 1 秒處（20 像素）
  await dragMediaTo(page, "music.mp3", "A2", 20);
  const a2 = page.locator('.track-row[data-track-id="A2"] .clip');
  await expect(a2).toHaveCount(1);
  await expect(a2).toHaveCSS("left", "20px");

  // Ctrl+Z 只拿掉最後一次放置，素材庫還在
  await page.keyboard.press("Control+z");
  await expect(a2).toHaveCount(0);
  await expect(page.locator(".media-item[data-media-id]")).toHaveCount(3);
  await page.keyboard.press("Control+Shift+z");
  await expect(a2).toHaveCount(1);

  // 預覽：拖到 1 秒，畫面有內容（testsrc2 是彩色測試圖）
  await page.locator(".ruler").click({ position: { x: 20, y: 5 } });
  await expect.poll(async () => page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const probe = document.createElement("canvas");
    probe.width = 64;
    probe.height = 36;
    const ctx = probe.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 64, 36);
    const data = ctx.getImageData(0, 0, 64, 36).data;
    let lit = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i] + data[i + 1] + data[i + 2] > 60) lit++;
    return lit / (64 * 36);
  }), { timeout: 10_000 }).toBeGreaterThan(0.3);

  // 播放：混音圖建立且 running，總輸出量得到聲音（440 Hz 正弦波）
  await page.getByTestId("play").click();
  await expect.poll(async () => (await audioProbe(page))?.state, { timeout: 5_000 }).toBe("running");
  await expect.poll(async () => (await audioProbe(page))?.level ?? 0, { timeout: 5_000 }).toBeGreaterThan(0.01);
  await page.getByTestId("play").click();
});
