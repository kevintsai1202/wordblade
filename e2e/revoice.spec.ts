import { expect, test, type Page, type Route } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// AI 重配音（spec §5.6）：30 秒的 speech30.mp4（440 Hz 大聲）放上時間軸，逐字稿用開發鉤子直接寫（每秒一個詞，共 28 秒的話）；
// Shift＋拖曳選 6～10 秒 → Re-voice → 改文字 → Generate（假閘道 /v1/tts：第一次回 7 秒、加快語速後回 6 秒的 1 kHz 音，都比範圍 4 秒長，
// 走「請模型加快 → 還是長 → 片段變速 1.5」）→ Voice 軌（A4）一個片段在 6 秒、切換原音／AI、Ctrl+Z；匯出檢查範圍內的 RMS：
// AI 狀態只剩 AI 的聲音（約 0.21，原音 0.57 被靜音），原音狀態是原音。
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const OUT = path.join(import.meta.dirname, "..", "output", "e2e-revoice");
const GATEWAY = "https://gateway.test";
/** 時間軸每秒幾像素（預設） */
const PX = 20;

/** 回應（含 CORS 標頭；預檢一律放行） */
async function reply(route: Route, status: number, body?: unknown) {
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
  return route.fulfill({ status, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body) });
}

/** 產生單聲道 16-bit PCM WAV：freq Hz 的正弦波，振幅 amp，長 seconds 秒 */
function toneWav(freq: number, seconds: number, amp: number, rate = 24000): Buffer {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVE", 8); buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
  buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(amp * 32767 * Math.sin((2 * Math.PI * freq * i) / rate)), 44 + i * 2);
  return buf;
}

/** 檔案 [a, b) 秒的聲音 RMS（單聲道 48 kHz） */
function rms(file: string, a: number, b: number): number {
  const raw = spawnSync("ffmpeg", ["-v", "error", "-ss", String(a), "-t", String(b - a), "-i", file, "-vn", "-ac", "1", "-ar", "48000", "-f", "s16le", "-"]).stdout as Buffer;
  const pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.length >> 1);
  let sum = 0;
  for (const v of pcm) sum += (v / 32768) ** 2;
  return Math.sqrt(sum / Math.max(1, pcm.length));
}

/** 匯出（OPFS）並存成檔案 */
async function exportTo(page: Page, name: string): Promise<string> {
  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 120_000 });
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

/** 目前專案（開發鉤子） */
const project = (page: Page) => page.evaluate(() => (window as unknown as { __wordblade: { project: () => any } }).__wordblade.project());

test("Re-voice：選範圍 → 改文字 → 產生（兩次加快後片段變速）→ Voice 軌、切換原音、復原、匯出靜音", async ({ page }) => {
  test.setTimeout(300_000);
  page.on("console", (m) => { if (m.type() === "error") console.log(`[console.error] ${m.text()}`); });
  const posts: { text: string; seedText: string; speed: number; seedBytes: number }[] = [];
  await page.route(`${GATEWAY}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return reply(route, 204);
    expect(req.headers()["authorization"]).toBe("Bearer test-token");
    if (req.method() === "POST" && req.url().endsWith("/v1/tts")) {
      const b = req.postDataJSON() as { text: string; seed: string; seedText: string; speed: number };
      posts.push({ text: b.text, seedText: b.seedText, speed: b.speed, seedBytes: Buffer.from(b.seed, "base64").length });
      return reply(route, 202, { jobId: `job-${posts.length}` });
    }
    // 第一次念 7 秒、第二次（加快語速）念 6 秒，都比範圍 4 秒長
    const seconds = req.url().endsWith("job-1") ? 7 : 6;
    return reply(route, 200, { status: "done", audio: toneWav(1000, seconds, 0.3).toString("base64"), seconds, error: null });
  });
  await page.addInitScript((url) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "test-token" }));
    localStorage.setItem("wordblade.exportToOpfs", "1");
    localStorage.setItem("wordblade.dev", "1");
  }, GATEWAY);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");

  // 匯入 30 秒的檔、放上 V1（同時有 A1 對白），寫入逐字稿：word0 ～ word27，每個 0.9 秒、間隔 0.1 秒（一整段連續的話）
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "speech30.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "speech30.mp4" }).dblclick();
  await page.evaluate(() => {
    const hook = (window as unknown as { __wordblade: { project: () => any; dispatch: (a: unknown) => void } }).__wordblade;
    const mediaId = hook.project().media[0].id;
    const words = Array.from({ length: 28 }, (_, i) => ({ id: `w${i}`, mediaId, text: `word${i}`, start: i + 0.05, end: i + 0.95 }));
    hook.dispatch({ type: "commit", edits: [{ kind: "setWords", mediaId, words }] });
  });

  // Shift＋拖曳選 6～10 秒
  await page.locator(".ruler").click({ position: { x: 1 + 6 * PX, y: 5 } });
  const row = (await page.locator('.track-row[data-track-id="V1"]').boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(row.x + 1 + 5.4 * PX, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + 1 + 10 * PX, row.y + row.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await expect(page.getByTestId("range-overlay")).toBeVisible();

  // Re-voice 按鈕 → 面板：文字預設是範圍內的逐字稿
  await page.getByTestId("range-revoice").click();
  await expect(page.getByTestId("revoice-tab")).toBeVisible();
  await expect(page.getByTestId("revoice-range")).toContainText("4.0 s");
  const text = page.getByTestId("revoice-text");
  await expect(text).toHaveValue(/^word[56] word[67]/);
  await expect(text).toHaveValue(/word9$/);
  await text.fill("This is the new line.");

  // 第一次要同意
  await page.getByTestId("revoice-generate").click();
  await expect(page.getByTestId("revoice-consent")).toContainText("Fish Audio");
  await page.getByTestId("revoice-consent").getByRole("button", { name: "Agree and continue" }).click();
  await expect(page.getByTestId("revoice-item")).toHaveCount(1, { timeout: 60_000 });

  // 閘道收到的：文字、樣本（約 28 秒的 WAV）、樣本文字；第二次語速加快（4 秒範圍、7 秒念完 → 1.3 上限）
  expect(posts).toHaveLength(2);
  expect(posts[0]).toMatchObject({ text: "This is the new line.", speed: 1 });
  expect(posts[1].speed).toBeGreaterThan(1);
  expect(posts[1].speed).toBeLessThanOrEqual(1.3);
  expect(posts[0].seedText).toContain("word0");
  expect(posts[0].seedText).toContain("word27");
  expect(posts[0].seedBytes).toBeGreaterThan(44 + 26 * 32000);
  expect(posts[0].seedBytes).toBeLessThan(44 + 30 * 32000);

  // Voice 軌（A4）一個片段在 6 秒；6 秒的聲音塞進 4 秒 → 片段變速 1.5
  await expect(page.locator('[data-track-id="A4"] .clip')).toHaveCount(1);
  let p = await project(page);
  const voice = p.tracks.find((t: any) => t.role === "voice");
  expect(voice.id).toBe("A4");
  const clip = p.clips.find((c: any) => c.trackId === "A4");
  // 拖曳以像素為單位（0.05 秒），起點只會接近 6 秒；片段一定放在重配音範圍的起點
  expect(clip.start).toBeGreaterThan(5.9);
  expect(clip.start).toBeLessThan(6.2);
  expect(clip.start).toBeCloseTo(p.voiceovers[0].start, 3);
  expect(clip.speed).toBeCloseTo(1.5, 2);
  expect(p.voiceovers).toHaveLength(1);
  expect(p.voiceovers[0]).toMatchObject({ text: "This is the new line.", active: true, clipId: clip.id });
  expect(p.voiceovers[0].end - p.voiceovers[0].start).toBeCloseTo(4, 0);
  await expect(page.getByTestId("revoice-toggle")).toHaveText("Playing: AI");

  // 匯出：範圍內只有 AI 的聲音（1 kHz，振幅 0.3 → RMS 約 0.21）；原音（RMS 約 0.57）被靜音；範圍外照舊
  const aiFile = await exportTo(page, "ai");
  const aiInside = rms(aiFile, 6.3, 9.7);
  expect(aiInside).toBeGreaterThan(0.12);
  expect(aiInside).toBeLessThan(0.3);
  expect(rms(aiFile, 2, 5)).toBeGreaterThan(0.45);
  expect(rms(aiFile, 12, 15)).toBeGreaterThan(0.45);

  // 切回原音：範圍內是原音
  await openTab(page, "revoice");
  await page.getByTestId("revoice-toggle").click();
  await expect(page.getByTestId("revoice-toggle")).toHaveText("Playing: Original");
  const origFile = await exportTo(page, "original");
  expect(rms(origFile, 6.3, 9.7)).toBeGreaterThan(0.45);
  expect(rms(origFile, 2, 5)).toBeGreaterThan(0.45);

  // Ctrl+Z：先復原切換（回到 AI），再復原產生（軌道、片段、紀錄一起不見；素材留在素材庫）
  await page.locator(".title-bar").click();
  await page.keyboard.press("Control+z");
  await openTab(page, "revoice");
  await expect(page.getByTestId("revoice-toggle")).toHaveText("Playing: AI");
  await page.locator(".title-bar").click();
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("revoice-item")).toHaveCount(0);
  await expect(page.locator('[data-track-id="A4"]')).toHaveCount(0);
  p = await project(page);
  expect(p.media.some((m: any) => m.name?.startsWith("voice-"))).toBe(true);

  // Redo 回來後可以刪除：片段與紀錄一起拿掉
  await page.keyboard.press("Control+Shift+z");
  await openTab(page, "revoice");
  await expect(page.getByTestId("revoice-item")).toHaveCount(1);
  await page.getByTestId("revoice-delete").click();
  await expect(page.getByTestId("revoice-item")).toHaveCount(0);
  await expect(page.locator('[data-track-id="A4"] .clip')).toHaveCount(0);
});

test("Re-voice：說話不到 20 秒時顯示錯誤、不送請求", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => { if (r.url().startsWith(GATEWAY)) requests.push(r.url()); });
  await page.addInitScript((url) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "test-token" }));
    localStorage.setItem("wordblade.consent.voice", "yes");
    localStorage.setItem("wordblade.dev", "1");
  }, GATEWAY);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  await page.evaluate(() => {
    const hook = (window as unknown as { __wordblade: { project: () => any; dispatch: (a: unknown) => void } }).__wordblade;
    const mediaId = hook.project().media[0].id;
    hook.dispatch({ type: "commit", edits: [{ kind: "setWords", mediaId, words: [{ id: "a", mediaId, text: "hello", start: 0.1, end: 1.5 }, { id: "b", mediaId, text: "again", start: 2, end: 3 }] }] });
  });
  await page.locator(".ruler").click({ position: { x: 1 + 1 * PX, y: 5 } });
  const row = (await page.locator('.track-row[data-track-id="V1"]').boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(row.x + 1 + 0.4 * PX, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + 1 + 3 * PX, row.y + row.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.getByTestId("range-revoice").click();
  await page.getByTestId("revoice-generate").click();
  await expect(page.getByTestId("revoice-error")).toContainText("Need at least 20 seconds of transcribed speech");
  expect(requests).toEqual([]);
  expect((await project(page)).voiceovers ?? []).toEqual([]);
});
