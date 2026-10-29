import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { toProjectFile } from "../src/core/projectFile";
import type { Media, Project, Word } from "../src/core/model";
import { openTab } from "./helpers/tabs";

// 範例專案打包（spec §5.22、docs/plan-10-29-sample.md）：照使用者的操作在網頁版把 samples/demo-2min.mp4 剪成範例專案，
// 再把專案與素材寫成 public/sample/（project.json＋media/）。不是一般的測試：只在設了 WORDBLADE_SAMPLE_BUILD 時執行。
//   最小版（不呼叫 AI）：pwsh -c '$env:WORDBLADE_SAMPLE_BUILD="offline"; npx playwright test e2e/sample-build.spec.ts'
//   完整版（實際跑 AI，S2）：之後由 scripts/sam/live-local.ps1 -E2E -Spec e2e/sample-build.spec.ts 起本機閘道執行
// 最小版的逐字稿用 samples/demo-2min.truth.json 的句子（詞平均攤開），特效用內建範本。
const MODE = process.env.WORDBLADE_SAMPLE_BUILD;
const ROOT = path.join(import.meta.dirname, "..");
const SAMPLE = path.join(ROOT, "samples", "demo-2min.mp4");
const OUT = path.join(ROOT, "public", "sample");
const truth = JSON.parse(readFileSync(path.join(ROOT, "samples", "demo-2min.truth.json"), "utf8")) as { sentences: { start: number; end: number; text: string }[] };

/** 開發用鉤子（App 在 localStorage wordblade.dev＝1 時提供） */
type Hook = { project: () => Project; dispatch: (a: unknown) => void; fileBytes: (k: string) => Promise<Uint8Array | null> };

/** 跳到 t 秒 */
async function seek(page: Page, t: number) {
  await page.evaluate((time) => (window as unknown as { __wordblade: Hook }).__wordblade.dispatch({ type: "seek", time }), t);
}

/** 選一段範圍（特效範本會放在範圍裡） */
async function range(page: Page, start: number, end: number) {
  await page.evaluate(([s, e]) => (window as unknown as { __wordblade: Hook }).__wordblade.dispatch({ type: "setRange", start: s, end: e }), [start, end]);
}

/** truth.json 的句子 → 詞（句子時間內平均攤開；最小版的逐字稿） */
function truthWords(mediaId: string): Word[] {
  const out: Word[] = [];
  truth.sentences.forEach((s, si) => {
    const tokens = s.text.split(/\s+/).filter(Boolean);
    const step = (s.end - s.start) / tokens.length;
    tokens.forEach((text, i) => out.push({ id: `w${si}-${i}`, mediaId, text, start: +(s.start + step * i).toFixed(3), end: +(s.start + step * (i + 1) - 0.02).toFixed(3) }));
  });
  return out;
}

test.skip(!MODE, "只在打包範例專案時執行（WORDBLADE_SAMPLE_BUILD=offline）");

test("打包範例專案", async ({ page }) => {
  test.setTimeout(600_000);
  /** 做了哪些、略過哪些（寫進 BUILD.md） */
  const log: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") console.log(`[console.error] ${m.text()}`); });
  await page.addInitScript(() => localStorage.setItem("wordblade.dev", "1"));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");

  // 匯入、放上 V1
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(SAMPLE);
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 60_000 });
  await page.locator(".media-item", { hasText: "demo-2min.mp4" }).dblclick();
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);
  const mediaId = await page.evaluate(() => (window as unknown as { __wordblade: Hook }).__wordblade.project().media[0].id);

  // 逐字稿
  await page.evaluate(([id, words]) => (window as unknown as { __wordblade: Hook }).__wordblade.dispatch({ type: "commit", edits: [{ kind: "setWords", mediaId: id, words }] }), [mediaId, truthWords(mediaId)] as const);
  log.push("Transcript: sentences from demo-2min.truth.json, words spread evenly (no AI).");

  // 字幕：逐字高亮
  await openTab(page, "style");
  await page.getByTestId("caption-karaoke").selectOption("fill");
  log.push("Captions: karaoke fill.");

  // 2D 特效（內建範本）：開頭標題卡、講到終端機時的箭頭
  await openTab(page, "vibe");
  await range(page, 1, 5);
  await page.locator('[data-template="title-pop"]').click();
  await range(page, 62, 66);
  await page.locator('[data-template="arrow-whoosh"]').click();
  log.push("2D effects: built-in Title card (1–5 s), Arrow (62–66 s).");

  // 3D：桌上螢幕、吉祥物
  await openTab(page, "vibe3d");
  await range(page, 20, 26);
  await page.locator('[data-template="desk-reveal"]').click();
  await range(page, 90, 94);
  await page.locator('[data-template="mascot-point"]').click();
  log.push("3D: Desk screen (20–26 s), Mascot points (90–94 s).");
  await expect(page.locator(".effect-chip")).toHaveCount(4);
  await page.evaluate(() => (window as unknown as { __wordblade: Hook }).__wordblade.dispatch({ type: "clearRange" }));
  await seek(page, 0);

  // 寫出：素材檔放 media/，路徑改成 sample/media/...（匯入的檔案沒有路徑，用位元組寫出）
  const project = await page.evaluate(() => (window as unknown as { __wordblade: Hook }).__wordblade.project());
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(path.join(OUT, "media"), { recursive: true });
  const used = new Set<string>();
  const media: Media[] = [];
  for (const m of project.media) {
    let name = (m.name ?? m.id).replace(/[^\w.-]+/g, "-");
    if (used.has(name)) name = `${m.id}-${name}`;
    used.add(name);
    const bytes = m.handleKey ? await page.evaluate(async (k) => {
      const b = await (window as unknown as { __wordblade: Hook }).__wordblade.fileBytes(k);
      return b ? Array.from(b) : null;
    }, m.handleKey) : null;
    if (!bytes) throw new Error(`No bytes for ${m.name}`);
    writeFileSync(path.join(OUT, "media", name), Buffer.from(bytes));
    const { handleKey: _h, proxyPath: _p, mezzaninePath: _z, ...rest } = m;
    media.push({ ...rest, path: `sample/media/${name}` });
  }
  writeFileSync(path.join(OUT, "project.json"), toProjectFile({ ...project, media }, { projectDir: "", savedAt: Date.now() }));
  writeFileSync(path.join(OUT, "BUILD.md"), [
    "# Sample project build",
    "",
    `Built ${new Date().toISOString()} by e2e/sample-build.spec.ts (mode: ${MODE}).`,
    "Footage: samples/demo-2min.mp4 — synthetic screen recording with a TTS voice-over, made by scripts/demo-sample (the API key in it is fake).",
    "",
    ...log.map((l) => `- ${l}`),
    "",
  ].join("\n"));
});
