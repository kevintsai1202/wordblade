import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// Demo 影片的螢幕錄影 S1～S6（docs/demo-script.md）：照分鏡自動操作 WordBlade，每段錄成一支 1920×1080 影片。
// 每次重錄畫面一致；失敗就重跑那一段（-g "S3"）。等 AI 的時間照實錄下來，剪片時用片段變速加速。
// 畫面上加一個假游標（Playwright 錄影看不到滑鼠），每次點擊前先慢慢移過去、點下去有一圈波紋。
// 連線上閘道（會花 token），網頁跑本機 dev server（CORS 放行 localhost:1420）：
//   $env:WORDBLADE_LIVE_TOKEN = '<權杖>'; $env:WORDBLADE_E2E_PORT = '1420'
//   pnpm playwright test e2e/demo-record-live.spec.ts            # 全部
//   pnpm playwright test e2e/demo-record-live.spec.ts -g "S3"    # 只錄一段
// 產出：output/demo-rec/S1-transcript.mp4 … S6-finish.mp4（另有同名 .webm 原檔）。需要 PATH 上有 ffmpeg。
const token = process.env.WORDBLADE_LIVE_TOKEN;
const GATEWAY = process.env.WORDBLADE_LIVE_GATEWAY ?? "https://wordblade-api.zeabur.app";
/** 原始錄影（重講、um、畫面上的假 API 金鑰都在裡面） */
const SOURCE = path.resolve(process.env.WORDBLADE_DEMO_SOURCE ?? "public/sample/media/demo-2min.mp4");
const OUT = path.join(import.meta.dirname, "..", "output", "demo-rec");
/** 錄影尺寸 */
const SIZE = { width: 1920, height: 1080 };
/** 時間軸每秒幾像素（預設縮放） */
const PX = 20;

test.skip(!token, "沒有設 WORDBLADE_LIVE_TOKEN");
test.describe.configure({ mode: "serial" });
test.use({ viewport: SIZE, video: { mode: "on", size: SIZE } });

/** 假游標：白色圓點跟著滑鼠，按下時一圈青綠色波紋 */
const CURSOR = () => {
  const install = () => {
    const dot = document.createElement("div");
    dot.style.cssText = "position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;background:rgba(255,255,255,.92);border:2px solid #0b0d10;box-shadow:0 2px 8px rgba(0,0,0,.5);pointer-events:none;left:-40px;top:-40px;transition:transform .08s";
    document.body.appendChild(dot);
    addEventListener("mousemove", (e) => { dot.style.left = `${e.clientX}px`; dot.style.top = `${e.clientY}px`; }, true);
    addEventListener("mousedown", (e) => {
      dot.style.transform = "scale(.8)";
      const r = document.createElement("div");
      r.style.cssText = `position:fixed;z-index:2147483646;left:${e.clientX - 24}px;top:${e.clientY - 24}px;width:48px;height:48px;border-radius:50%;border:3px solid #2fe0c0;pointer-events:none;transition:all .45s ease-out;opacity:1`;
      document.body.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = "scale(1.8)"; r.style.opacity = "0"; });
      setTimeout(() => r.remove(), 500);
    }, true);
    addEventListener("mouseup", () => { dot.style.transform = ""; }, true);
  };
  if (document.body) install(); else addEventListener("DOMContentLoaded", install);
};

/**
 * 操作點紀錄：每次點擊或打字的時間（錄影開始起算的秒數）與位置（畫面比例 0～1），剪片時用來自動放大與圈選
 * （e2e/demo-cut-live.spec.ts）。錄影從開頁時開始，t0 在 start() 記下。
 */
const marks: { t: number; x: number; y: number; w: number; h: number; what: string }[] = [];
let t0 = 0;
/** 記一個操作點（元素的框） */
function mark(box: { x: number; y: number; width: number; height: number }, what: string) {
  marks.push({ t: (Date.now() - t0) / 1000, x: (box.x + box.width / 2) / SIZE.width, y: (box.y + box.height / 2) / SIZE.height, w: box.width / SIZE.width, h: box.height / SIZE.height, what });
}

/** 停一下（讓觀眾看清楚） */
const pause = (page: Page, ms = 800) => page.waitForTimeout(ms);

/** 游標慢慢移到元素中間再點 */
async function act(page: Page, target: Locator, opts: { double?: boolean; modifiers?: ("Shift" | "Control")[] } = {}) {
  await target.scrollIntoViewIfNeeded();
  // scrollIntoView 可能把右側面板橫向捲掉一半：捲回最左
  await target.evaluate((el) => { for (let p = el.parentElement; p; p = p.parentElement) p.scrollLeft = 0; });
  const box = (await target.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 18 });
  await pause(page, 250);
  mark(box, (await target.getAttribute("data-testid")) ?? (await target.innerText().catch(() => "")).slice(0, 30));
  if (opts.double) await target.dblclick({ modifiers: opts.modifiers });
  else await target.click({ modifiers: opts.modifiers });
  await pause(page, 500);
}

/** 打字速度（每個字的間隔，毫秒）：剪片時打字段落用原速，這個速度觀眾看得清楚在打什麼 */
const TYPE_DELAY = 65;

/** 一個字一個字打（看得到在打字）；記下打字的起訖（剪片時原速、放大到輸入框、鋪打字聲） */
async function type(page: Page, target: Locator, text: string) {
  await act(page, target);
  await target.fill("");
  const box = (await target.boundingBox())!;
  mark(box, "type-start");
  await target.pressSequentially(text, { delay: TYPE_DELAY });
  mark(box, "type-end");
  await pause(page, 600);
}

/** 打開右側頁籤（游標移過去再點） */
async function tab(page: Page, id: string) {
  await page.mouse.move(SIZE.width - 300, 60, { steps: 10 });
  await openTab(page, id);
  await pause(page, 600);
}

/** 播放頭移到 t 秒，再播 1.5 秒讓預覽確實畫出那一格（只跳格時預覽偶爾停在黑畫面） */
async function seek(page: Page, t: number) {
  const r = (await page.locator(".ruler").boundingBox())!;
  await page.mouse.move(r.x + 1 + t * PX, r.y + 5, { steps: 14 });
  await page.mouse.click(r.x + 1 + t * PX, r.y + 5);
  await pause(page, 500);
  await page.keyboard.press("Space");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Space");
  await pause(page, 600);
}

/** Shift＋拖曳選時間範圍 [a, b] 秒 */
async function range(page: Page, a: number, b: number) {
  const r = (await page.locator(".ruler").boundingBox())!;
  await page.mouse.move(r.x + 1 + a * PX, r.y + 5, { steps: 12 });
  await page.mouse.click(r.x + 1 + a * PX, r.y + 5);
  const row = (await page.locator('.track-row[data-track-id="V1"]').boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(row.x + 1 + a * PX, row.y + row.height / 2, { steps: 8 });
  await page.mouse.down();
  await page.mouse.move(row.x + 1 + b * PX, row.y + row.height / 2, { steps: 24 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("range-overlay")).toBeVisible();
  await pause(page, 600);
}

/** 開 WordBlade、匯入原始錄影放上 V1 */
async function start(page: Page, consents: string[]) {
  marks.length = 0;
  t0 = Date.now();
  await page.addInitScript(CURSOR);
  await page.addInitScript(([url, tok, list]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    for (const k of list as string[]) localStorage.setItem(`wordblade.consent.${k}`, "yes");
    localStorage.setItem("wordblade.exportToOpfs", "1");
    localStorage.setItem("wordblade.dev", "1");
  }, [GATEWAY, token!, consents] as const);
  await page.goto("/");
  await pause(page, 1200);
  const chooser = page.waitForEvent("filechooser");
  await act(page, page.getByTestId("import-media"));
  await (await chooser).setFiles(SOURCE);
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 120_000 });
  await act(page, page.locator(".media-item").first(), { double: true });
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);
  await pause(page, 800);
}

/** 轉錄並等完成 */
async function transcribe(page: Page) {
  await tab(page, "transcript");
  await expect(page.getByTestId("transcribe-start")).toBeEnabled({ timeout: 120_000 });
  await act(page, page.getByTestId("transcribe-start"));
  await expect(page.locator('[data-testid="transcribe-status"], [data-testid="transcribe-error"]')).toHaveCount(1, { timeout: 300_000 });
  await expect(page.getByTestId("transcribe-error")).toHaveCount(0);
  await pause(page, 1500);
}

/** 錄完：關頁讓影片寫完，改名、轉成 mp4（WordBlade 網頁版只收 MP4） */
async function finish(page: Page, name: string) {
  await pause(page, 1500);
  const video = page.video()!;
  await page.close();
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, `${name}.marks.json`), JSON.stringify(marks, null, 1));
  const webm = path.join(OUT, `${name}.webm`);
  await video.saveAs(webm);
  const mp4 = path.join(OUT, `${name}.mp4`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", webm, "-c:v", "libx264", "-crf", "18", "-pix_fmt", "yuv420p", "-r", "30", mp4]);
  if (!existsSync(mp4)) throw new Error(`轉檔失敗：${mp4}`);
  console.log(`已存 ${path.relative(process.cwd(), mp4)}`);
}

test("S1 字幕與改字剪片：匯入 → Muse 轉錄 → 選字刪掉，時間軸跟著剪", async ({ page }) => {
  test.setTimeout(900_000);
  await start(page, ["asr"]);
  await transcribe(page);
  const transcript = page.getByTestId("transcript");
  // 刪掉開頭附近的一個 um／uh（找不到就刪第 3～4 個字）
  const filler = transcript.locator("[data-word-id]", { hasText: /^(um|uh|Um|Uh)[,.]?$/ }).first();
  const target = (await filler.count()) ? filler : transcript.locator("[data-word-id]").nth(3);
  await act(page, target);
  await pause(page, 600);
  await page.keyboard.press("Delete");
  await pause(page, 1500);
  // 再選一段（Shift 點）刪掉，看時間軸變短
  const words = transcript.locator("[data-word-id]");
  await act(page, words.nth(20));
  await act(page, words.nth(24), { modifiers: ["Shift"] });
  await pause(page, 600);
  await page.keyboard.press("Delete");
  await pause(page, 2000);
  await finish(page, "S1-transcript");
});

test("S2 AI 導演：看完整支 → 建議清單 → 逐條採用", async ({ page }) => {
  test.setTimeout(1_800_000);
  await start(page, ["asr", "director", "sam", "vibe", "plane3d"]);
  await transcribe(page);
  await tab(page, "director");
  await expect(page.getByTestId("director-ask")).toBeEnabled({ timeout: 120_000 });
  await act(page, page.getByTestId("director-ask"));
  await expect(page.getByTestId("director-message")).toBeVisible({ timeout: 900_000 });
  await pause(page, 1500);
  // 清單逐條移過去看一下，再按「套用勾選的」
  for (const row of (await page.getByTestId("director-row").all()).slice(0, 6)) {
    const b = await row.boundingBox();
    if (b) { await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 }); await pause(page, 700); }
  }
  await act(page, page.getByTestId("director-apply-checked"));
  await expect(page.getByTestId("director-apply-checked")).toHaveCount(0, { timeout: 900_000 });
  await pause(page, 2500);
  await finish(page, "S2-director");
});

test("S3 SAM 遮罩：框出金鑰出現的範圍 → 打「API key」→ 追蹤 → 馬賽克", async ({ page }) => {
  test.setTimeout(900_000);
  await start(page, ["sam"]);
  await seek(page, 40);
  await range(page, 38, 46);
  await act(page, page.getByTestId("range-mask"));
  // 「Other…」才有自己打字的欄位
  await act(page, page.locator(".mask-targets button", { hasText: "Other" }));
  await type(page, page.getByTestId("mask-custom"), "API key");
  await act(page, page.getByTestId("mask-find"));
  await expect(page.getByTestId("mask-message")).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId("mask-row").first()).toBeVisible();
  await pause(page, 1000);
  await seek(page, 41);
  await pause(page, 2500);
  await finish(page, "S3-mask");
});

test("S4 Vibe 2D 與 Vibe 3D：一句話 → Muse Wonder 寫出新插件", async ({ page }) => {
  test.setTimeout(1_200_000);
  await start(page, ["vibe"]);
  await range(page, 60, 66);
  await tab(page, "vibe");
  await type(page, page.getByTestId("vibe-description"), "A yellow highlight sweeps under the output, then 'It works!' pops in");
  await act(page, page.getByTestId("vibe-generate"));
  await expect(page.locator(".effect-chip").or(page.getByTestId("vibe-error"))).toHaveCount(1, { timeout: 480_000 });
  await expect(page.getByTestId("vibe-error")).toHaveCount(0);
  await seek(page, 63);
  await pause(page, 2500);
  await range(page, 70, 76);
  await tab(page, "vibe3d");
  await type(page, page.getByTestId("vibe-description"), "A glossy golden trophy spinning in the corner, with sparkles");
  await act(page, page.getByTestId("vibe-generate"));
  await expect(page.locator(".effect-chip").or(page.getByTestId("vibe-error"))).toHaveCount(2, { timeout: 480_000 });
  await expect(page.getByTestId("vibe-error")).toHaveCount(0);
  await seek(page, 73);
  await pause(page, 3000);
  await finish(page, "S4-vibe");
});

test("S5 3D 場景：桌上螢幕（固定鏡頭）＋機器人吉祥物", async ({ page }) => {
  test.setTimeout(600_000);
  await start(page, []);
  await range(page, 80, 88);
  await tab(page, "vibe3d");
  await act(page, page.locator('[data-template="desk-still"]'));
  await expect(page.locator(".effect-chip")).toHaveCount(1);
  await range(page, 81.5, 88);
  await act(page, page.locator('[data-template="robot-wave"]'));
  await expect(page.locator(".effect-chip")).toHaveCount(2);
  // 播一段給觀眾看（空白鍵播放、再按一次停）
  await seek(page, 80);
  await page.keyboard.press("Space");
  await page.waitForTimeout(8000);
  await page.keyboard.press("Space");
  await pause(page, 1000);
  await finish(page, "S5-scene3d");
});

test("S6 收尾：逐字高亮字幕、AI 音效、發佈包、匯出", async ({ page }) => {
  test.setTimeout(1_200_000);
  await start(page, ["asr", "audio", "publish", "image"]);
  await transcribe(page);
  await tab(page, "style");
  await act(page, page.getByTestId("caption-karaoke"));
  await page.getByTestId("caption-karaoke").selectOption("fill");
  await seek(page, 20);
  await pause(page, 2000);
  // AI 音效
  await range(page, 30, 31);
  await tab(page, "audio");
  await type(page, page.getByTestId("sound-description"), "a soft whoosh for a slide transition");
  await act(page, page.getByTestId("sound-generate"));
  await expect(page.getByTestId("sound-result").or(page.getByTestId("sound-error"))).toBeVisible({ timeout: 180_000 });
  await pause(page, 1500);
  // 發佈包（標題、說明、章節）＋縮圖
  await tab(page, "publish");
  await act(page, page.getByTestId("publish-generate"));
  const consent = page.getByRole("button", { name: "Agree and continue" });
  if (await consent.isVisible({ timeout: 2_000 }).catch(() => false)) await act(page, consent);
  await expect(page.getByTestId("publish-titles").locator("input[type=text]")).toHaveCount(3, { timeout: 300_000 });
  await pause(page, 2500);
  // 匯出：錄到進度條跑一段就好（整支匯出要好幾分鐘，剪片時用成品）
  await tab(page, "export");
  await act(page, page.getByTestId("export-start"));
  await page.waitForTimeout(8000);
  await finish(page, "S6-finish");
});
