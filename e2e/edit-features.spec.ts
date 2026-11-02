import { expect, test, type Page } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// 11/2 一次做完的剪輯功能（docs/plan-11-02-edit-features.md）：
// ① 轉場（穿白）＋定格＋色彩調整（選範圍）全用介面操作，匯出後用 ffmpeg 逐格檢查像素；
// ② 2D 圖層的圖片填色：同一格的預覽截圖，填色前後要不一樣；
// ③ 卡拉 OK 重配錄音：Chromium 假麥克風，倒數 → 提詞器 → 自動停 → Voice 軌、原聲靜音。
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const OUT = path.join(import.meta.dirname, "..", "output", "e2e-edit-features");
/** 時間軸每秒幾像素（預設） */
const PX = 20;

test.use({ launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] } });

/** 目前專案（開發鉤子） */
const project = (page: Page) => page.evaluate(() => (window as unknown as { __wordblade: { project: () => any } }).__wordblade.project());

/** 播放頭移到 t 秒 */
async function seek(page: Page, t: number) {
  await page.locator(".ruler").click({ position: { x: 1 + t * PX, y: 5 } });
}

/** 開頁面、匯入 speech30.mp4（30 秒 testsrc2）放上 V1 */
async function setup(page: Page) {
  page.on("console", (m) => { if (m.type() === "error") console.log(`[console.error] ${m.text()}`); });
  await page.addInitScript(() => {
    localStorage.setItem("wordblade.exportToOpfs", "1");
    localStorage.setItem("wordblade.dev", "1");
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "speech30.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "speech30.mp4" }).dblclick();
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);
}

/** Shift＋拖曳選範圍 [a, b] 秒（在 V1 上）：範圍從播放頭開始，所以先把播放頭移到 a */
async function selectRange(page: Page, a: number, b: number) {
  await seek(page, a);
  const row = (await page.locator('.track-row[data-track-id="V1"]').boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(row.x + 1 + a * PX, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + 1 + b * PX, row.y + row.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("range-overlay")).toBeVisible();
}

/** 匯出（OPFS）並存成檔案 */
async function exportTo(page: Page, name: string): Promise<string> {
  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 180_000 });
  const b64 = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `${name}.mp4`);
  writeFileSync(file, Buffer.from(b64, "base64"));
  return file;
}

/** 檔案在 t 秒那一格縮成 32×18 的 RGB 像素 */
function frameAt(file: string, t: number): Uint8Array {
  const out = spawnSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", file, "-frames:v", "1", "-vf", "scale=32:18", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout as Buffer;
  return new Uint8Array(out);
}

/** 平均亮度 */
const mean = (px: Uint8Array) => px.reduce((s, v) => s + v, 0) / Math.max(1, px.length);
/** 兩格的平均差 */
const diff = (a: Uint8Array, b: Uint8Array) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / Math.max(1, a.length);

/** 檔案長度（秒） */
function duration(file: string): number {
  const out = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]).stdout.toString();
  return Number(out);
}

test("轉場（穿白）＋定格＋色彩（選範圍）：介面操作 → 匯出逐格檢查", async ({ page }) => {
  test.setTimeout(300_000);
  await setup(page);

  // 10 秒切開，後一段加「穿白」轉場 1 秒
  await seek(page, 10);
  await page.keyboard.press("Control+b");
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(2);
  await page.locator('.track-row[data-track-id="V1"] .clip').nth(1).click();
  await openTab(page, "inspector");
  await page.getByTestId("transition-kind").selectOption("dipWhite");
  await page.getByTestId("transition-duration").fill("1");
  let p = await project(page);
  expect(p.transitions).toHaveLength(1);
  expect(p.transitions[0]).toMatchObject({ kind: "dipWhite", duration: 1 });

  // 5 秒插 2 秒定格（Shift+F）：總長 32 秒，接點移到 12 秒
  await seek(page, 5);
  await page.keyboard.press("Shift+F");
  p = await project(page);
  const freeze = p.clips.find((c: any) => c.freeze);
  // 尺規點擊會落在最近的格附近（約 5.05 秒）
  expect(freeze.start).toBeCloseTo(5, 0);
  expect(freeze.freeze.at).toBeCloseTo(freeze.start, 6);
  expect(freeze.freeze.hold).toBe(2);

  // 選 20～24 秒，Color 頁籤把亮度拉到最低（只調這段）
  await selectRange(page, 20, 24);
  await openTab(page, "color");
  await expect(page.getByTestId("color-add")).toHaveText("New for selected range");
  const slider = page.getByTestId("color-brightness");
  await slider.focus();
  await page.keyboard.press("Home");
  p = await project(page);
  expect(p.colorGrades).toHaveLength(1);
  expect(p.colorGrades[0].brightness).toBe(-1);
  expect(p.colorGrades[0].start).toBeCloseTo(20, 0);
  expect(p.colorGrades[0].end).toBeCloseTo(24, 0);

  const file = await exportTo(page, "transition-freeze-color");
  expect(duration(file)).toBeCloseTo(32, 0);
  // 接點 12 秒是全白；前後各 1 秒外是一般畫面
  expect(mean(frameAt(file, 12))).toBeGreaterThan(235);
  expect(mean(frameAt(file, 10.9))).toBeLessThan(200);
  // 定格 5～7 秒：兩格一樣（testsrc2 一直在動，沒定格的話會不同）
  expect(diff(frameAt(file, 5.3), frameAt(file, 6.7))).toBeLessThan(3);
  expect(diff(frameAt(file, 8.3), frameAt(file, 9.7))).toBeGreaterThan(3);
  // 色彩：22 秒（範圍內）比 27 秒（範圍外）暗很多
  const dark = mean(frameAt(file, 22));
  const normal = mean(frameAt(file, 27));
  console.log(`brightness: in range ${dark.toFixed(1)}, outside ${normal.toFixed(1)}`);
  expect(normal - dark).toBeGreaterThan(50);
});

test("2D 圖層的圖片填色：選材質後同一格的預覽不一樣，Ctrl+Z 回到原樣", async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  // 材質圖：匯入 card.png（testsrc2 彩色格），用開發鉤子加進材質庫
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "card.png"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.evaluate(() => {
    const hook = (window as unknown as { __wordblade: { project: () => any; dispatch: (a: unknown) => void } }).__wordblade;
    const img = hook.project().media.find((m: any) => m.kind === "image");
    hook.dispatch({ type: "commit", edits: [{ kind: "addTexture", texture: { id: "tex1", kind: "texture", name: "Checker", prompt: "test", colorMediaId: img.id, normalStrength: 1, repeat: 2 } }] });
  });

  await seek(page, 1);
  await openTab(page, "vibe");
  await page.locator('[data-template="title-typewriter"]').click();
  await expect(page.locator(".effect-chip")).toHaveCount(1, { timeout: 15_000 });
  // 特效開始後 1.5 秒（打字機的字已經出來，和 effects.spec 同一個時間點）
  await seek(page, 2.5);
  await page.waitForTimeout(1000);
  const canvas = page.locator(".preview canvas").first();
  const before = await canvas.screenshot();

  await page.locator(".effect-chip").click();
  await openTab(page, "inspector");
  await page.getByTestId("layer-fill-texture").first().selectOption("tex1");
  expect((await project(page)).effects[0].params.layers[0].fill).toMatchObject({ textureId: "tex1", repeat: 2, mix: 1 });
  await page.waitForTimeout(1500);
  const filled = await canvas.screenshot();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "fill-before.png"), before);
  writeFileSync(path.join(OUT, "fill-after.png"), filled);
  expect(Buffer.compare(before, filled)).not.toBe(0);

  await page.keyboard.press("Control+z");
  const proj = await project(page);
  expect(proj.effects[0].params.layers[0].fill).toBeUndefined();
});

test("卡拉 OK 重配錄音：選範圍 → Record → 倒數 → 提詞器逐字亮 → 自動停 → Voice 軌（剪到範圍長度）", async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  await page.evaluate(() => {
    const hook = (window as unknown as { __wordblade: { project: () => any; dispatch: (a: unknown) => void } }).__wordblade;
    const mediaId = hook.project().media[0].id;
    const words = Array.from({ length: 28 }, (_, i) => ({ id: `w${i}`, mediaId, text: `word${i}`, start: i + 0.05, end: i + 0.95 }));
    hook.dispatch({ type: "commit", edits: [{ kind: "setWords", mediaId, words }] });
  });
  await selectRange(page, 6, 8.6);
  await page.getByTestId("range-revoice").click();
  await expect(page.getByTestId("revoice-text")).toHaveValue(/word/);

  await page.getByTestId("revoice-record").click();
  await expect(page.getByTestId("karaoke-countdown")).toHaveText("3");
  await expect(page.getByTestId("karaoke")).toHaveAttribute("data-phase", "recording", { timeout: 6_000 });
  // 錄音中有一個詞亮著
  await expect(page.locator('[data-testid="karaoke-text"] .now')).toHaveCount(1, { timeout: 3_000 });
  // 範圍約 2.6 秒，自動停並放上 Voice 軌
  await expect(page.getByTestId("revoice-item")).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId("revoice-toggle")).toHaveText("Playing: Your take");
  const p = await project(page);
  const vo = p.voiceovers[0];
  expect(vo.source).toBe("recorded");
  const clip = p.clips.find((c: any) => c.id === vo.clipId);
  expect(clip.srcOut - clip.srcIn).toBeLessThanOrEqual(vo.end - vo.start + 1e-6);
  expect(clip.srcOut - clip.srcIn).toBeGreaterThan(vo.end - vo.start - 0.5);
  const track = p.tracks.find((t: any) => t.id === clip.trackId);
  expect(track.role).toBe("voice");
});
