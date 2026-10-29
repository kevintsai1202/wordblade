import { expect, test, type Locator, type Page } from "@playwright/test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { toProjectFile } from "../src/core/projectFile";
import type { Media, Project, Word } from "../src/core/model";
import { openTab } from "./helpers/tabs";

// 範例專案打包（spec §5.22、docs/plan-10-29-sample.md）：照使用者的操作在網頁版把 samples/demo-2min.mp4 剪成範例專案，
// 再把專案與素材寫成 public/sample/（project.json＋media/＋thumbnail.png＋BUILD.md）。不是一般的測試：只在設了 WORDBLADE_SAMPLE_BUILD 時執行。
//   最小版（不呼叫 AI）：$env:WORDBLADE_SAMPLE_BUILD="offline"; npx playwright test e2e/sample-build.spec.ts
//   完整版（實際跑 AI）：$env:WORDBLADE_SAMPLE_BUILD="live"; pwsh scripts/sam/live-local.ps1 -E2E -Spec e2e/sample-build.spec.ts
//     （先 node scripts/sample/covers.mjs 產生片頭封面）
// 完整版每個 AI 步驟失敗時退回不呼叫 AI 的做法（逐字稿用 truth.json、特效用內建範本）或略過，結果寫進 BUILD.md。
const MODE = process.env.WORDBLADE_SAMPLE_BUILD;
const LIVE = MODE === "live";
const gateway = process.env.WORDBLADE_LIVE_GATEWAY;
const token = process.env.WORDBLADE_LIVE_TOKEN;
const ROOT = path.join(import.meta.dirname, "..");
const SAMPLE = path.join(ROOT, "samples", "demo-2min.mp4");
const COVERS = path.join(ROOT, "samples", "sample-covers");
const OUT = path.join(ROOT, "public", "sample");
const truth = JSON.parse(readFileSync(path.join(ROOT, "samples", "demo-2min.truth.json"), "utf8")) as {
  sentences: { start: number; end: number; text: string }[];
  apiKey: { start: number; end: number };
  retake: { start: number; end: number };
};

/** 開發用鉤子（App 在 localStorage wordblade.dev＝1 時提供） */
type Hook = { project: () => Project; dispatch: (a: unknown) => void; fileBytes: (k: string) => Promise<Uint8Array | null>; thumbnail: () => Promise<number[] | null> };
const hook = (page: Page) => page.evaluateHandle(() => (window as unknown as { __wordblade: Hook }).__wordblade);

/** 送一個動作給 reducer */
async function dispatch(page: Page, action: unknown) {
  await page.evaluate((a) => (window as unknown as { __wordblade: Hook }).__wordblade.dispatch(a), action);
}

/** 選一段範圍（特效範本、AI 特效、配樂都放在範圍起點） */
const range = (page: Page, start: number, end: number) => dispatch(page, { type: "setRange", start, end });

/** truth.json 的句子 → 詞（句子時間內平均攤開；AI 轉錄失敗時的退路） */
function truthWords(mediaId: string): Word[] {
  const out: Word[] = [];
  truth.sentences.forEach((s, si) => {
    const tokens = s.text.split(/\s+/).filter(Boolean);
    const step = (s.end - s.start) / tokens.length;
    tokens.forEach((text, i) => out.push({ id: `w${si}-${i}`, mediaId, text, start: +(s.start + step * i).toFixed(3), end: +(s.start + step * (i + 1) - 0.02).toFixed(3) }));
  });
  return out;
}

/** 找一條和 [a, b] 重疊的某種導演建議 */
async function overlapping(page: Page, kind: string, a: number, b: number): Promise<Locator | null> {
  const list = page.getByTestId("director-list").locator(`[data-kind="${kind}"]`);
  for (let i = 0; i < (await list.count()); i++) {
    const row = list.nth(i);
    if (Number(await row.getAttribute("data-start")) < b && Number(await row.getAttribute("data-end")) > a) return row;
  }
  return null;
}

test.skip(!MODE, "只在打包範例專案時執行（WORDBLADE_SAMPLE_BUILD=offline 或 live）");

test("打包範例專案", async ({ page }) => {
  test.setTimeout(1_800_000);
  if (LIVE) expect(gateway && token, "完整版要由 scripts/sam/live-local.ps1 起閘道與權杖").toBeTruthy();
  /** 做了哪些、退回或略過哪些（寫進 BUILD.md） */
  const log: string[] = [];
  /** 跑一個 AI 步驟：失敗就記下來並執行退路 */
  const step = async (name: string, run: () => Promise<string>, fallback?: () => Promise<string>) => {
    const t0 = Date.now();
    try {
      log.push(`${name}: ${await run()} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    } catch (e) {
      const why = String(e instanceof Error ? e.message : e).split("\n")[0].slice(0, 160);
      log.push(`${name}: AI step failed (${why}); ${fallback ? await fallback() : "skipped"}`);
    }
    console.log(log[log.length - 1]);
  };
  page.on("console", (m) => { if (m.type() === "error") console.log(`[console.error] ${m.text()}`); });
  await page.addInitScript(([url, tok]) => {
    localStorage.setItem("wordblade.dev", "1");
    if (url && tok) localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    for (const k of ["asr", "director", "sam", "vibe", "plane3d", "audio", "publish"]) localStorage.setItem(`wordblade.consent.${k}`, "yes");
  }, [gateway ?? "", token ?? ""]);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");

  // 匯入、放上 V1
  let chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(SAMPLE);
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 120_000 });
  await page.locator(".media-item", { hasText: "demo-2min.mp4" }).dblclick();
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);
  const mediaId = await page.evaluate(() => (window as unknown as { __wordblade: Hook }).__wordblade.project().media[0].id);
  const useTruth = async () => {
    await dispatch(page, { type: "commit", edits: [{ kind: "setWords", mediaId, words: truthWords(mediaId) }] });
    return "used the sentences from demo-2min.truth.json instead";
  };

  // 逐字稿（Muse ASR）
  if (LIVE) {
    await step("Transcript (Muse ASR)", async () => {
      await openTab(page, "transcript");
      await expect(page.getByTestId("transcribe-start")).toBeEnabled({ timeout: 120_000 });
      await page.getByTestId("transcribe-start").click();
      await expect(page.getByTestId("transcribe-status")).toContainText("words", { timeout: 300_000 });
      return (await page.getByTestId("transcribe-status").innerText()).replace(/\s+/g, " ");
    }, useTruth);
  } else {
    log.push(`Transcript: ${await useTruth()} (no AI).`);
  }

  // 一鍵去贅詞（導演不管贅詞，先剪掉）
  await step("Filler words", async () => {
    await openTab(page, "transcript");
    await page.getByTestId("find-fillers").click();
    const n = await page.getByTestId("cleanup-item").count();
    if (n) await page.getByTestId("cleanup-remove").click();
    return `removed ${n}`;
  });

  if (LIVE) {
    // AI 導演（docs/plan-10-29-director2.md）：理解 → 規劃剪輯腳本 → 縮圖總表審查 → 套用審查通過的全部（剪、遮罩、放大、特效、3D 轉場、字幕、配樂、片頭）
    await step("AI director (Spark understands, Wonder plans, a second Wonder reviews; apply all that passed)", async () => {
      await openTab(page, "director");
      await expect(page.getByTestId("director-ask")).toBeEnabled({ timeout: 120_000 });
      await page.getByTestId("director-ask").click();
      await expect(page.getByTestId("director-message")).toBeVisible({ timeout: 600_000 });
      const rows = page.getByTestId("director-row");
      const plan: string[] = [];
      for (const r of await rows.all()) plan.push(`${await r.getAttribute("data-kind")}@${await r.getAttribute("data-start")}(${await r.getAttribute("data-review")})`);
      const checked = await page.getByTestId("director-check").count();
      await page.getByTestId("director-apply-checked").click();
      await expect(page.getByTestId("director-apply-checked")).toHaveCount(0, { timeout: 900_000 });
      const failed = await page.getByTestId("director-message").innerText().catch(() => "");
      return `${plan.length} items [${plan.join(", ")}]; applied ${checked} checked. ${failed}`.trim();
    });
  } else {
    // 不呼叫 AI 的最小版：逐字高亮、內建 2D 範本、桌上螢幕＋吉祥物、片頭
    await openTab(page, "style");
    await page.getByTestId("caption-karaoke").selectOption("fill");
    log.push("Captions: karaoke fill.");
    const builtin2D = async (template: string, at: number) => {
      await openTab(page, "vibe");
      await range(page, at, at + 4);
      await page.locator(`[data-template="${template}"]`).click();
      return `built-in ${template}`;
    };
    log.push(`2D effects: ${await builtin2D("title-pop", 1)}; ${await builtin2D("arrow-whoosh", 60)} (no AI).`);
    await openTab(page, "vibe3d");
    await range(page, 20, 26);
    await page.locator('[data-template="desk-reveal"]').click();
    await range(page, 88, 92);
    await page.locator('[data-template="mascot-point"]').click();
    log.push("3D: Desk screen (20–26 s), Mascot points (88–92 s).");
    await dispatch(page, { type: "clearRange" });
    const covers = existsSync(COVERS) ? readdirSync(COVERS).filter((f) => f.endsWith(".webp")).map((f) => path.join(COVERS, f)) : [];
    if (covers.length) {
      await openTab(page, "media");
      chooser = page.waitForEvent("filechooser");
      await page.getByTestId("import-media").click();
      await (await chooser).setFiles(covers);
      // 一張一張匯入：等全部進了素材庫（「處理中」可能在兩張之間短暫歸零）
      await expect(page.locator(".media-item", { hasText: "cover-" })).toHaveCount(covers.length, { timeout: 120_000 });
      await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 60_000 });
      await openTab(page, "intro");
      await page.getByTestId("intro-title").fill("Meeting Notes AI");
      await page.getByTestId("intro-subtitle").fill("a CLI tool in 2 minutes");
      await page.getByTestId("intro-generate").click();
      await expect(page.getByTestId("intro-notice")).toContainText("intro at the start", { timeout: 120_000 });
      log.push(`Intro: flip intro with ${covers.length} covers made by Muse Image (scripts/sample/covers.mjs), built-in music.`);
    }
  }

  // 發佈包＋縮圖
  if (LIVE) {
    await step("Publish kit (Muse Spark)", async () => {
      await openTab(page, "publish");
      await page.getByTestId("publish-generate").click();
      await expect(page.getByTestId("publish-titles").locator("input[type=text]")).toHaveCount(3, { timeout: 180_000 });
      return `titles: ${(await page.getByTestId("publish-titles").locator("input[type=text]").first().inputValue())} …`;
    });
    await step("Thumbnail (Muse Image)", async () => {
      await openTab(page, "publish");
      await dispatch(page, { type: "seek", time: 40 });
      await page.waitForTimeout(1500);
      await page.getByTestId("thumb-ai").click();
      await expect(page.getByTestId("thumb-ai")).toHaveText("Restyle with AI", { timeout: 240_000 });
      await expect(page.getByTestId("publish-error")).toHaveCount(0);
      return "restyled the frame at 40 s";
    });
  }
  await dispatch(page, { type: "seek", time: 0 });

  // 寫出：素材檔放 media/，路徑改成 sample/media/...（匯入與產生的檔案都用位元組寫出）
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
  const thumb = await page.evaluate(() => (window as unknown as { __wordblade: Hook }).__wordblade.thumbnail());
  if (thumb) writeFileSync(path.join(OUT, "thumbnail.png"), Buffer.from(thumb));
  writeFileSync(path.join(OUT, "BUILD.md"), [
    "# Sample project build",
    "",
    `Built ${new Date().toISOString()} by e2e/sample-build.spec.ts (mode: ${MODE}).`,
    "Footage: samples/demo-2min.mp4 — a synthetic screen recording with a TTS voice-over, made by scripts/demo-sample (the API key in it is fake).",
    "",
    ...log.map((l) => `- ${l}`),
    "",
  ].join("\n"));
  void hook;
});
