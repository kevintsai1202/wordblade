import { expect, test } from "@playwright/test";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// Muse ASR 實機測試（spec §5.2）：連真的閘道與 Muse Voice Transcribe（會花錢，約 US$0.18／小時音訊），只在設了環境變數時跑：
//   pwsh scripts/asr/live-local.ps1        （起本機閘道與臨時資料庫、建一次性權杖、跑這支、收掉）
// 素材 samples/lecture-a.en.mp4（282 秒英文 TTS 配音，附逐句 SRT）：轉錄後把字幕的起點和 SRT 的句子起點比對，
// 量「句子起點」的誤差（§5.2 的驗收是詞級、真人錄音，這裡只是 TTS、句級的近似）。結果寫到 output/asr-live.json。
const gateway = process.env.WORDBLADE_LIVE_GATEWAY;
const token = process.env.WORDBLADE_LIVE_TOKEN;
// 素材可用 WORDBLADE_ASR_SAMPLE 換（例如模擬的 D30 短片 samples/demo-2min.mp4，旁邊有 .truth.json 時另外比對語助詞與重講）
const SAMPLE = process.env.WORDBLADE_ASR_SAMPLE ?? path.join(import.meta.dirname, "..", "samples", "lecture-a.en.mp4");
const SRT = SAMPLE.replace(/(\.en)?\.mp4$/, (m) => m.replace(".mp4", ".srt"));
const TRUTH = SAMPLE.replace(/\.mp4$/, ".truth.json");
const BASE = path.basename(SAMPLE, ".mp4");

test.skip(!gateway || !token, "沒有設 WORDBLADE_LIVE_GATEWAY／WORDBLADE_LIVE_TOKEN");

/** SRT → [{起點秒, 文字}] */
function readSrt(file: string): { start: number; text: string }[] {
  return readFileSync(file, "utf8").replace(/\r/g, "").trim().split(/\n\n+/).map((block) => {
    const lines = block.split("\n");
    const [h, m, s, ms] = lines[1].split(" --> ")[0].split(/[:,]/).map(Number);
    return { start: h * 3600 + m * 60 + s + ms / 1000, text: lines.slice(2).join(" ") };
  });
}

/** 比對用：小寫、去標點，取前三個詞 */
function key(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
}

test("Muse ASR 實機：英文 TTS 講課片轉錄，字幕句子起點對 SRT 的誤差", async ({ page }) => {
  test.setTimeout(300_000);
  await page.addInitScript(([url, tok, max]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    localStorage.setItem("wordblade.consent.asr", "yes");
    localStorage.setItem("wordblade.debug", "1");
    if (max) localStorage.setItem("wordblade.asr.maxSegment", max);
  }, [gateway!, token!, process.env.WORDBLADE_ASR_MAX_SEGMENT ?? ""]);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(SAMPLE);
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 120_000 });
  await page.locator(".media-item", { hasText: BASE }).dblclick();
  await openTab(page, "transcript");
  await expect(page.getByTestId("transcribe-start")).toBeEnabled({ timeout: 120_000 });
  const t0 = Date.now();
  await page.getByTestId("transcribe-start").click();
  await expect(page.locator('[data-testid="transcribe-status"], [data-testid="transcribe-error"]')).toHaveCount(1, { timeout: 280_000 });
  await expect(page.getByTestId("transcribe-error")).toHaveCount(0);
  const seconds = (Date.now() - t0) / 1000;
  const status = await page.getByTestId("transcribe-status").innerText();
  // Muse 的原始 turns（素材時間；TranscribePanel 在 wordblade.debug 時放到 window）
  const raw = await page.evaluate(() => (window as unknown as { __wordbladeAsr?: unknown }).__wordbladeAsr ?? null);
  const warning = await page.getByTestId("transcribe-warning").count() ? await page.getByTestId("transcribe-warning").innerText() : null;

  // 一鍵去贅詞與清除無聲片段（§5.16、§5.16b）在這支片上找到幾條（只找、不剪）
  await page.getByTestId("find-fillers").click();
  const fillerItems = await page.getByTestId("cleanup-item").count();
  const fillerLabels = await page.getByTestId("cleanup-item").locator(".label").allInnerTexts();
  await page.getByTestId("find-pauses").click();
  const pauseItems = await page.getByTestId("cleanup-item").count();

  // 字幕：逐字稿頁籤每段的時間碼（MM:SS:FF，30 fps）與文字
  const captions = await page.locator(".transcript li").evaluateAll((items) => items.map((li) => ({
    code: li.querySelector(".timecode")?.textContent ?? "",
    text: li.querySelector(".caption-text")?.textContent ?? "",
  })));
  const parsed = captions.map((c) => {
    const [m, s, f] = c.code.split(":").map(Number);
    return { start: m * 60 + s + f / 30, text: c.text };
  });
  // 沒有 SRT 的素材（例如 FOSDEM 的真人演講片段）只看速度、涵蓋率與語助詞
  const srt = existsSync(SRT) ? readSrt(SRT) : [];
  const errors: { srt: number; caption: number; text: string }[] = [];
  for (const cue of srt) {
    const k = key(cue.text);
    // 起點最接近、開頭三個詞相同的字幕
    // 開頭三個詞相同、起點相差 3 秒內（避免兩句同樣開頭時配錯，例如講錯重講的那兩句）
    const match = parsed.filter((c) => key(c.text) === k && Math.abs(c.start - cue.start) < 3).sort((a, b) => Math.abs(a.start - cue.start) - Math.abs(b.start - cue.start))[0];
    if (match) errors.push({ srt: cue.start, caption: match.start, text: cue.text.slice(0, 40) });
  }
  const abs = errors.map((e) => Math.abs(e.caption - e.srt)).sort((a, b) => a - b);
  const mean = abs.reduce((a, b) => a + b, 0) / Math.max(1, abs.length);
  // 有正確答案時：語助詞保留了幾個（逐字稿裡 um／uh／you know 的次數對講稿）、重講的句子有沒有轉出來
  let fillers: Record<string, { expected: number; found: number }> | null = null;
  let retakeFound: boolean | null = null;
  if (existsSync(TRUTH)) {
    const truth = JSON.parse(readFileSync(TRUTH, "utf8")) as { fillers: { word: string }[] };
    const all = " " + parsed.map((c) => c.text).join(" ").toLowerCase().replace(/[^\p{L}\s']/gu, " ") + " ";
    fillers = {};
    for (const word of ["um", "uh", "you know"]) {
      fillers[word] = { expected: truth.fillers.filter((f) => f.word === word).length, found: all.split(` ${word} `).length - 1 };
    }
    retakeFound = all.includes("say that again");
  }
  const result = {
    cleanup: { fillers: fillerItems, fillerLabels, pauses: pauseItems },
    sample: BASE, maxSegment: process.env.WORDBLADE_ASR_MAX_SEGMENT ?? "default", fillers, retakeFound,
    seconds, status, warning, captions: parsed.length, srtCues: srt.length, matched: errors.length,
    meanStartError: Number(mean.toFixed(3)), medianStartError: Number((abs[Math.floor(abs.length / 2)] ?? 0).toFixed(3)),
    p90StartError: Number((abs[Math.floor(abs.length * 0.9)] ?? 0).toFixed(3)), errors, captionList: parsed, raw,
  };
  mkdirSync(path.join(import.meta.dirname, "..", "output"), { recursive: true });
  writeFileSync(path.join(import.meta.dirname, "..", "output", "asr-live.json"), JSON.stringify(result, null, 2));
  console.log(`清理清單：贅詞 ${fillerItems} 條（${[...new Set(fillerLabels.map((l) => l.toLowerCase()))].join("、")}）、≥ 1 秒的停頓 ${pauseItems} 段`);
  if (fillers) console.log(`語助詞（找到／講稿）：${Object.entries(fillers).map(([w, v]) => `${w} ${v.found}/${v.expected}`).join("、")}；重講句${retakeFound ? "有" : "沒有"}轉出來`);
  console.log(`ASR 實機：${seconds.toFixed(1)} 秒，${status}；SRT ${srt.length} 句、對上 ${errors.length} 句，起點誤差平均 ${result.meanStartError} 秒、中位數 ${result.medianStartError}、p90 ${result.p90StartError}${warning ? `；${warning}` : ""}`);
  await page.screenshot({ path: "output/ui-shots/asr-live.png" });
  // Muse 每次斷句（標點）不同，對上的句數會變；只要求對上三分之一，數字看 output/asr-live.json
  if (srt.length) expect(errors.length).toBeGreaterThanOrEqual(srt.length / 3);
});
