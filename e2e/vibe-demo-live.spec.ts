import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// Vibe 功能實機展示（2026-11-02）：連線上網頁版與閘道（會花 token），用一段真實影片依序做
// ① Vibe 2D（0.5～5 秒）② Vibe 3D（6～11 秒）③ 3D 場景範本＋「用說的」控制鏡頭（12～18 秒），最後匯出 mp4 給人確認。
// 只在設了環境變數時跑（權杖只從環境變數讀）：
//   $env:WORDBLADE_LIVE_SITE = 'https://wordblade.zeabur.app'; $env:WORDBLADE_LIVE_TOKEN = '<邀請權杖>'
//   $env:WORDBLADE_DEMO_VIDEO = 'output/vibe-demo/source-20s.mp4'
//   pnpm playwright test e2e/vibe-demo-live.spec.ts
// 結果：output/vibe-demo/vibe-demo.mp4 與各步驟截圖。
const site = process.env.WORDBLADE_LIVE_SITE;
const token = process.env.WORDBLADE_LIVE_TOKEN;
const video = process.env.WORDBLADE_DEMO_VIDEO;
/** 閘道網址（線上版） */
const GATEWAY = process.env.WORDBLADE_LIVE_GATEWAY ?? "https://wordblade-api.zeabur.app";
const OUT = path.join(import.meta.dirname, "..", "output", "vibe-demo");
/** 時間軸每秒幾像素（預設） */
const PX = 20;

test.skip(!site || !token || !video, "沒有設 WORDBLADE_LIVE_SITE／WORDBLADE_LIVE_TOKEN／WORDBLADE_DEMO_VIDEO");
test.use({ baseURL: site });

/** 播放頭移到 t 秒 */
async function seek(page: Page, t: number) {
  await page.locator(".ruler").click({ position: { x: 1 + t * PX, y: 5 } });
}

/** Shift＋拖曳選範圍 [a, b] 秒（範圍從播放頭開始，先 seek 到 a） */
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

/** Vibe 產生一個特效：等時間軸多一個特效片段、沒有錯誤 */
async function generate(page: Page, tab: "vibe" | "vibe3d", description: string, chips: number) {
  await openTab(page, tab);
  await page.getByTestId("vibe-description").fill(description);
  const t0 = Date.now();
  await page.getByTestId("vibe-generate").click();
  await expect(page.locator('.effect-chip').or(page.getByTestId("vibe-error"))).toHaveCount(chips, { timeout: 280_000 });
  await expect(page.getByTestId("vibe-error")).toHaveCount(0);
  console.log(`${tab}：${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
}

test("Vibe 實機展示：2D、3D、3D 場景用說的 → 匯出", async ({ page }) => {
  test.setTimeout(1_200_000);
  page.on("console", (m) => { if (m.type() === "error") console.log(`[console.error] ${m.text()}`); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(([url, tok]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    for (const k of ["vibe", "plane3d", "texture"]) localStorage.setItem(`wordblade.consent.${k}`, "yes");
    localStorage.setItem("wordblade.exportToOpfs", "1");
  }, [GATEWAY, token!]);
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.resolve(video!));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 60_000 });
  await page.locator(".media-item").first().dblclick();
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);
  mkdirSync(OUT, { recursive: true });

  // ① Vibe 2D
  await selectRange(page, 0.5, 5);
  await generate(page, "vibe", "A bold yellow highlighter underline that sweeps across the lower third, then a pop-in title card saying 'Key idea' with confetti", 1);
  await seek(page, 3);
  await page.screenshot({ path: path.join(OUT, "1-vibe2d.png") });

  // ② Vibe 3D
  await selectRange(page, 6, 11);
  await generate(page, "vibe3d", "A glossy 3D golden trophy spinning slowly in the top-right corner, with small sparkles orbiting it", 2);
  await seek(page, 8.5);
  await page.screenshot({ path: path.join(OUT, "2-vibe3d.png") });

  // ③ 3D 場景範本（影片貼在桌上的螢幕）＋用說的控制鏡頭
  await selectRange(page, 12, 18);
  await openTab(page, "vibe3d");
  await page.locator('[data-template="board-float"]').click();
  await expect(page.locator(".effect-chip")).toHaveCount(3);
  await page.locator(".effect-chip").last().click();
  await openTab(page, "inspector");
  await page.getByTestId("move-description").fill("Start wide from the left side, then slowly dolly in until the screen fills the frame");
  await page.getByTestId("move-propose").click();
  const consent = page.getByRole("button", { name: "Agree and continue" });
  if (await consent.isVisible({ timeout: 2_000 }).catch(() => false)) await consent.click();
  await page.getByTestId("move-apply").click({ timeout: 120_000 });
  await seek(page, 15);
  await page.screenshot({ path: path.join(OUT, "3-plane3d.png") });

  // 匯出並存檔
  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 600_000 });
  const b64 = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  writeFileSync(path.join(OUT, "vibe-demo.mp4"), Buffer.from(b64, "base64"));
});
