import { expect, test, type Locator } from "@playwright/test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// AI 導演實機（會呼叫真的 Muse ASR、Spark、Wonder、SAM，約 US$0.1）：由 scripts/sam/live-local.ps1 -E2E -Spec e2e/director-live.spec.ts 執行。
// 模擬短片 samples/demo-2min.mp4（有正確答案）：匯入 → AI 導演（沒有逐字稿先自動轉錄）→ 建議裡要有蓋到假金鑰時間的 mask、蓋到重講的 cut
// → 採用那條 mask（真的跑 SAM）與 cut → 截圖。環境變數 WORDBLADE_LIVE_GATEWAY、WORDBLADE_LIVE_TOKEN；沒設就跳過。
const gateway = process.env.WORDBLADE_LIVE_GATEWAY;
const token = process.env.WORDBLADE_LIVE_TOKEN;
/** 換素材（例如 samples/lecture-a.en.mp4）時只看能不能跑完、印出建議，不比對正確答案、不採用 */
const OTHER = process.env.WORDBLADE_DIRECTOR_SAMPLE;
/** 沿用上一次存下的逐字稿（$env:WORDBLADE_DIRECTOR_REUSE_WORDS="1"）：只重跑導演，比較兩次導演的結果時排除轉錄的差異 */
const REUSE_WORDS = process.env.WORDBLADE_DIRECTOR_REUSE_WORDS === "1";
/** 換素材時，逐字稿存在這裡（下一次沿用） */
const WORDS_FILE = "output/director-live-words.json";
/** 換素材時套用勾選的建議並匯出（$env:WORDBLADE_DIRECTOR_APPLY="1"） */
const APPLY = process.env.WORDBLADE_DIRECTOR_APPLY === "1";
const SAMPLE = OTHER ? path.resolve(OTHER) : path.join(import.meta.dirname, "..", "samples", "demo-2min.mp4");
const truth = JSON.parse(readFileSync(path.join(import.meta.dirname, "..", "samples", "demo-2min.truth.json"), "utf8"));

test.skip(!gateway || !token, "needs WORDBLADE_LIVE_GATEWAY and WORDBLADE_LIVE_TOKEN");

/** 找一條和 [a, b] 重疊的某種建議 */
async function overlapping(rows: Locator, kind: string, a: number, b: number): Promise<Locator | null> {
  const list = rows.locator(`[data-kind="${kind}"]`);
  for (let i = 0; i < (await list.count()); i++) {
    const row = list.nth(i);
    const s = Number(await row.getAttribute("data-start"));
    const e = Number(await row.getAttribute("data-end"));
    if (s < b && e > a) return row;
  }
  return null;
}

test("實機：AI 導演找到假金鑰與重講，採用遮罩與剪", async ({ page }) => {
  test.setTimeout(APPLY ? 3_000_000 : 900_000);
  await page.addInitScript(([url, tok]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    for (const k of ["director", "sam", "vibe", "plane3d", "asr", "audio"]) localStorage.setItem(`wordblade.consent.${k}`, "yes");
    // 匯出寫進 OPFS（不開存檔對話框），再從 OPFS 拿出來
    localStorage.setItem("wordblade.exportToOpfs", "1");
    // 開發用鉤子（讀寫專案的逐字稿）
    localStorage.setItem("wordblade.dev", "1");
  }, [gateway!, token!]);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(SAMPLE);
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 60_000 });
  await page.locator(".media-item", { hasText: path.basename(SAMPLE) }).dblclick();
  // 沿用上一次的逐字稿：素材 id 換成這次匯入的
  if (OTHER && REUSE_WORDS && existsSync(WORDS_FILE)) {
    const saved = JSON.parse(readFileSync(WORDS_FILE, "utf8")) as { text: string; start: number; end: number; id: string }[];
    await page.evaluate((list) => {
      const hook = (window as unknown as { __wordblade: { project: () => { media: { id: string }[] }; dispatch: (a: unknown) => void } }).__wordblade;
      const mediaId = hook.project().media[0].id;
      hook.dispatch({ type: "commit", edits: [{ kind: "setWords", mediaId, words: list.map((w) => ({ ...w, id: `${mediaId}:${w.id.split(":").pop()}`, mediaId })) }] });
    }, saved);
    console.log(`沿用逐字稿：${saved.length} 個詞`);
  }

  await openTab(page, "director");
  await expect(page.getByTestId("director-ask")).toBeEnabled({ timeout: 120_000 });
  const t0 = Date.now();
  await page.getByTestId("director-ask").click();
  await expect(page.getByTestId("director-message")).toBeVisible({ timeout: 600_000 });
  console.log(`導演實機：${((Date.now() - t0) / 1000).toFixed(1)} 秒；${await page.getByTestId("director-message").innerText()}`);
  const rows = page.getByTestId("director-list");
  for (const row of await page.getByTestId("director-row").all()) console.log(`  ${await row.getAttribute("data-kind")} ${await row.getAttribute("data-start")}–${await row.getAttribute("data-end")} ${(await row.innerText()).replace(/\s+/g, " ")}`);
  // 導演構想（docs/plan-10-30-director3.md）：觀眾與觀眾會看不清的問題
  for (const note of await page.getByTestId("director-treatment").locator("summary, li").allTextContents().catch(() => [] as string[])) console.log(`  構想：${note}`);
  if (OTHER) {
    await expect(page.getByTestId("director-row").first()).toBeVisible();
    // 逐字稿開頭（中文要是繁體，src/asr/traditional.ts）；寫成 UTF-8 檔，免得主控台編碼亂掉
    await openTab(page, "transcript");
    mkdirSync("output", { recursive: true });
    writeFileSync("output/director-live-transcript.txt", (await page.getByTestId("transcript").innerText()).slice(0, 2000), "utf8");
    // 逐字稿的詞存下來，下一次可以沿用（WORDBLADE_DIRECTOR_REUSE_WORDS）
    const words = await page.evaluate(() => (window as unknown as { __wordblade: { project: () => { words: unknown[] } } }).__wordblade.project().words);
    writeFileSync(WORDS_FILE, JSON.stringify(words), "utf8");
    await openTab(page, "director");
    await page.screenshot({ path: "output/ui-shots/director-live-other.png" });
    if (APPLY) {
      // 套用勾選的建議 → 匯出整支 → 存成 output/director-live-export.mp4（人工看剪出來的樣子）
      await page.getByTestId("director-apply-checked").click();
      await expect(page.getByTestId("director-apply-checked")).toHaveCount(0, { timeout: 900_000 });
      console.log(`套用：${await page.getByTestId("director-message").innerText()}`);
      await openTab(page, "export");
      await page.getByTestId("export-start").click();
      await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 1_400_000 });
      const b64 = await page.evaluate(async () => {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
        const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
        let s = "";
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
        return btoa(s);
      });
      writeFileSync("output/director-live-export.mp4", Buffer.from(b64, "base64"));
      console.log("匯出：output/director-live-export.mp4");
    }
    return;
  }
  const mask = await overlapping(rows, "mask", truth.apiKey.start, truth.apiKey.end);
  const cut = await overlapping(rows, "cut", truth.retake.start, truth.retake.end);
  expect(mask, "a mask suggestion over the fake API key").not.toBeNull();
  expect(cut, "a cut suggestion over the retake").not.toBeNull();

  // 採用遮罩（真的跑 SAM）與剪
  await mask!.getByTestId("director-adopt").click();
  await expect(mask!).toHaveAttribute("data-status", "applied", { timeout: 180_000 });
  // 金鑰遮罩由 Spark 每秒 1 格找框：至少有一格和正確答案的框 IoU ≥ 0.5
  await openTab(page, "mask");
  const boxes = JSON.parse((await page.locator('[data-testid="mask-row"][data-shape="rect"]').first().getAttribute("data-boxes"))!) as number[][];
  const t = truth.apiKey.box;
  const iou = (b: number[]) => {
    const ix = Math.max(0, Math.min(b[2], t.x + t.w) - Math.max(b[0], t.x));
    const iy = Math.max(0, Math.min(b[3], t.y + t.h) - Math.max(b[1], t.y));
    return (ix * iy) / ((b[2] - b[0]) * (b[3] - b[1]) + t.w * t.h - ix * iy);
  };
  const best = Math.max(...boxes.map(iou));
  console.log(`金鑰遮罩：${boxes.length} 個取樣，最好的 IoU ${best.toFixed(2)}`);
  expect(best).toBeGreaterThanOrEqual(0.5);
  await openTab(page, "director");
  await cut!.getByTestId("director-adopt").click();
  await expect(cut!).toHaveAttribute("data-status", "applied");
  await mask!.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: "output/ui-shots/director-live.png" });
});
