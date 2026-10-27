import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

// Muse ASR 實機測試（spec §5.2）：連真的閘道與 Muse Voice Transcribe（會花錢，約 US$0.18／小時音訊），只在設了環境變數時跑：
//   pwsh scripts/asr/live-local.ps1        （起本機閘道與臨時資料庫、建一次性權杖、跑這支、收掉）
// 素材 samples/lecture-a.en.mp4（282 秒英文 TTS 配音，附逐句 SRT）：轉錄後把字幕的起點和 SRT 的句子起點比對，
// 量「句子起點」的誤差（§5.2 的驗收是詞級、真人錄音，這裡只是 TTS、句級的近似）。結果寫到 output/asr-live.json。
const gateway = process.env.WORDBLADE_LIVE_GATEWAY;
const token = process.env.WORDBLADE_LIVE_TOKEN;
const SAMPLE = path.join(import.meta.dirname, "..", "samples", "lecture-a.en.mp4");
const SRT = SAMPLE.replace(/\.mp4$/, ".srt");

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
  await page.addInitScript(([url, tok]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    localStorage.setItem("wordblade.consent.asr", "yes");
  }, [gateway!, token!]);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(SAMPLE);
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 120_000 });
  await page.locator(".media-item", { hasText: "lecture-a" }).dblclick();
  await page.locator('[data-tab="transcript"]').click();
  await expect(page.getByTestId("transcribe-start")).toBeEnabled({ timeout: 120_000 });
  const t0 = Date.now();
  await page.getByTestId("transcribe-start").click();
  await expect(page.locator('[data-testid="transcribe-status"], [data-testid="transcribe-error"]')).toHaveCount(1, { timeout: 280_000 });
  await expect(page.getByTestId("transcribe-error")).toHaveCount(0);
  const seconds = (Date.now() - t0) / 1000;
  const status = await page.getByTestId("transcribe-status").innerText();
  const warning = await page.getByTestId("transcribe-warning").count() ? await page.getByTestId("transcribe-warning").innerText() : null;

  // 字幕：逐字稿頁籤每段的時間碼（MM:SS:FF，30 fps）與文字
  const captions = await page.locator(".transcript li").evaluateAll((items) => items.map((li) => ({
    code: li.querySelector(".timecode")?.textContent ?? "",
    text: li.querySelector(".caption-text")?.textContent ?? "",
  })));
  const parsed = captions.map((c) => {
    const [m, s, f] = c.code.split(":").map(Number);
    return { start: m * 60 + s + f / 30, text: c.text };
  });
  const srt = readSrt(SRT);
  const errors: { srt: number; caption: number; text: string }[] = [];
  for (const cue of srt) {
    const k = key(cue.text);
    // 起點最接近、開頭三個詞相同的字幕
    const match = parsed.filter((c) => key(c.text) === k).sort((a, b) => Math.abs(a.start - cue.start) - Math.abs(b.start - cue.start))[0];
    if (match) errors.push({ srt: cue.start, caption: match.start, text: cue.text.slice(0, 40) });
  }
  const abs = errors.map((e) => Math.abs(e.caption - e.srt)).sort((a, b) => a - b);
  const mean = abs.reduce((a, b) => a + b, 0) / Math.max(1, abs.length);
  const result = {
    seconds, status, warning, captions: parsed.length, srtCues: srt.length, matched: errors.length,
    meanStartError: Number(mean.toFixed(3)), medianStartError: Number((abs[Math.floor(abs.length / 2)] ?? 0).toFixed(3)),
    p90StartError: Number((abs[Math.floor(abs.length * 0.9)] ?? 0).toFixed(3)), errors,
  };
  mkdirSync(path.join(import.meta.dirname, "..", "output"), { recursive: true });
  writeFileSync(path.join(import.meta.dirname, "..", "output", "asr-live.json"), JSON.stringify(result, null, 2));
  console.log(`ASR 實機：${seconds.toFixed(1)} 秒，${status}；SRT ${srt.length} 句、對上 ${errors.length} 句，起點誤差平均 ${result.meanStartError} 秒、中位數 ${result.medianStartError}、p90 ${result.p90StartError}${warning ? `；${warning}` : ""}`);
  await page.screenshot({ path: "output/ui-shots/asr-live.png" });
  expect(errors.length).toBeGreaterThan(srt.length / 2);
});
