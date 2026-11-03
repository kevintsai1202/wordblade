import { expect, test, type Page, type Route } from "@playwright/test";
import { openTab } from "./helpers/tabs";

// AI 音效與 AI 音樂（spec §5.15、D27）的介面流程：真的在瀏覽器用 OfflineAudioContext 算 WAV、匯入素材庫、放上時間軸；
// 閘道回應由 Playwright 攔截（不連真的 AI）。
const GATEWAY = "https://gateway.test";

/** 回應（含 CORS 標頭；預檢一律放行） */
async function reply(route: Route, status: number, body?: unknown) {
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
  return route.fulfill({ status, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body) });
}

/** 一份 4 小節的配樂 spec（bpm 可換，「改一下」時回慢一點的版本） */
function musicSpec(bpm: number) {
  return {
    bpm, bars: 4, chords: ["Am", "F", "C", "G"],
    parts: [
      { role: "pad", gain: 0.3, loopBars: 1, voice: { source: { type: "osc", wave: "triangle" }, env: { attack: 0.2, decay: 0.3, sustain: 0.7, release: 0.5 } }, notes: [0, 1, 2].map((c) => ({ at: 0, len: 4, chord: c })) },
      { role: "drums", loopBars: 1, notes: [{ at: 0, len: 0.5, drum: "kick" }, { at: 2, len: 0.5, drum: "snare" }] },
    ],
  };
}

/** 打開特效 → 音效子頁籤；token 給了就先存 AI 設定 */
async function setup(page: Page, token: string | null) {
  page.on("console", (m) => { if (m.type() === "error") console.log(`[console.error] ${m.text()}`); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  if (token) {
    await page.evaluate((url) => localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "test-token" })), GATEWAY);
    await page.reload();
  }
  await openTab(page, "audio");
}

test("音效範本：不用 AI 直接算成 WAV → 素材庫 → 放到 A3 音效軌（一次復原）", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => { if (r.url().startsWith(GATEWAY)) requests.push(r.url()); });
  await setup(page, null);
  const chips = page.getByTestId("sound-template");
  expect(await chips.count()).toBeGreaterThanOrEqual(8);
  await page.locator('[data-template="pop"]').click();
  await expect(page.getByTestId("sound-result")).toContainText("0.15 s");
  await page.getByTestId("sound-add").click();

  // 進素材庫（音訊素材）並放在 A3
  await openTab(page, "media");
  await expect(page.locator(".media-item.audio")).toHaveCount(1, { timeout: 15_000 });
  await expect(page.locator(".media-item.audio .media-name")).toContainText(/^sfx-pop-.*\.wav$/);
  await expect(page.locator('[data-track-id="A3"] .clip')).toHaveCount(1);
  await expect(page.locator('[data-track-id="A2"] .clip')).toHaveCount(0);
  // 範本不用 AI：沒有同意說明、沒有送任何請求
  expect(requests).toEqual([]);

  // 規格存進專案（2026-11-01）：音效頁籤列出這一版，打開來沿用同一個素材（不重複匯入）
  await openTab(page, "audio");
  await expect(page.locator('[data-testid="synth-item"][data-kind="sound"]')).toHaveCount(1);
  await page.locator('[data-template="whoosh"]').click();
  await page.getByTestId("synth-item").click();
  await expect(page.getByTestId("sound-save")).toHaveText("In media");
  await openTab(page, "media");

  // Ctrl+Z 一次就拿掉片段與存的規格（同一次提交；素材留在素材庫）
  await page.locator(".title-bar").click();
  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-track-id="A3"] .clip')).toHaveCount(0);
  await expect(page.locator(".media-item.audio")).toHaveCount(1);
  await openTab(page, "audio");
  await expect(page.getByTestId("synth-item")).toHaveCount(0);
});

test("AI 音樂：同意說明 → 生成 → 放到 A2；「改一下」帶著前一版 spec", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  await page.route(`${GATEWAY}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return reply(route, 204);
    expect(req.headers()["authorization"]).toBe("Bearer test-token");
    if (req.method() === "POST" && req.url().endsWith("/v1/ai/music")) {
      bodies.push(req.postDataJSON());
      return reply(route, 202, { jobId: `job-${bodies.length}` });
    }
    // 第一版 120 BPM；改版後 90 BPM
    const bpm = req.url().endsWith("job-1") ? 120 : 90;
    return reply(route, 200, { status: "done", round: 1, result: { refusal: null, spec: musicSpec(bpm) }, error: null });
  });
  await setup(page, "test-token");
  await page.getByTestId("music-description").fill("calm lo-fi");
  await page.getByTestId("music-bars").selectOption("4");
  await page.getByTestId("music-generate").click();
  // 同意說明要提到 Muse Spark 與訓練（D32）
  await expect(page.getByTestId("audio-consent")).toContainText("Muse Spark");
  await expect(page.getByTestId("audio-consent")).toContainText("train");
  await page.getByRole("button", { name: "Agree and continue" }).click();

  await expect(page.getByTestId("music-result")).toContainText("4 bars · 120 BPM · 8.0 s", { timeout: 20_000 });
  expect(bodies[0]).toEqual({ description: "calm lo-fi", bars: 4, previous: null });
  await page.getByTestId("music-add").click();
  await expect(page.locator('[data-track-id="A2"] .clip')).toHaveCount(1, { timeout: 15_000 });

  // 改一下：送修改指示＋前一版 spec，結果換成新版本
  await page.getByTestId("music-tweak").fill("slower");
  await page.getByTestId("music-modify").click();
  await expect(page.getByTestId("music-result")).toContainText("90 BPM", { timeout: 20_000 });
  expect(bodies[1]).toMatchObject({ description: "slower", bars: 4, previous: { bpm: 120, bars: 4 } });
  // 新版本是新的素材：再加一次就多一個片段
  await page.getByTestId("music-add").click();
  await expect(page.locator('[data-track-id="A2"] .clip')).toHaveCount(2, { timeout: 15_000 });
  // 兩版配樂的規格都存進專案
  await expect(page.locator('[data-testid="synth-item"][data-kind="music"]')).toHaveCount(2);

  // 再生成一次：用原本的描述重來（不帶前一版、不疊修改指示）
  await page.getByTestId("music-regenerate").click();
  await expect.poll(() => bodies.length, { timeout: 20_000 }).toBe(3);
  expect(bodies[2]).toEqual({ description: "calm lo-fi", bars: 4, previous: null });
});

test("AI 音效：拒答顯示固定文字，不顯示模型的文字", async ({ page }) => {
  await page.route(`${GATEWAY}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "POST") return reply(route, 202, { jobId: "job-s" });
    return reply(route, 200, { status: "done", round: 1, result: { refusal: "off-topic", spec: null }, error: null });
  });
  await page.addInitScript(() => localStorage.setItem("wordblade.consent.audio", "yes"));
  await setup(page, "test-token");
  await page.getByTestId("sound-description").fill("Write me a poem");
  await page.getByTestId("sound-generate").click();
  await expect(page.getByTestId("sound-error")).toContainText("doesn't sound like a sound effect");
  await expect(page.getByTestId("sound-result")).toHaveCount(0);
});
