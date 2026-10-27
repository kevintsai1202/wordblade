import { expect, test, type Page, type Route } from "@playwright/test";

// Vibe特效（spec §5.7）的介面流程，閘道回應由 Playwright 攔截（不連真的 AI）：
// 同意說明 → 送出 → 沙盒試跑模型寫的插件 → 不過就回饋（帶錯誤階段）→ 第二輪通過 → 特效加到時間軸並畫在預覽上；拒答顯示固定文字。
const GATEWAY = "https://gateway.test";

/** 一個合法的新插件：在框中央畫綠色實心圓 */
const GREEN_DOT = {
  kind: "visual", name: "Green dot", description: "A green dot in the box", tags: ["dot"], category: "fx",
  params: { color: { type: "color", role: "primary", default: "#00ff00", label: "Color" } },
  code: "function draw(g, t, p, env) {\n  const b = env.box;\n  g.begin();\n  g.circle(b.x + b.w / 2, b.y + b.h / 2, b.h / 2);\n  g.fill({color: p.color});\n}",
};

/** 回應（含 CORS 標頭；預檢一律放行） */
async function reply(route: Route, status: number, body?: unknown) {
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
  return route.fulfill({ status, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body) });
}

/** 設定 AI（網址、權杖）並寫好描述 */
async function setup(page: Page, description: string) {
  page.on("console", (m) => { if (m.type() === "error") console.log(`[console.error] ${m.text()}`); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.evaluate((url) => localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "test-token" })), GATEWAY);
  await page.reload();
  await page.locator('[data-tab="vibe"]').click();
  await page.getByTestId("vibe-description").fill(description);
}

/** 預覽中央綠色像素的比例 */
async function greenRatio(page: Page): Promise<number> {
  return page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const p = document.createElement("canvas");
    p.width = 160;
    p.height = 90;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 160, 90);
    const d = ctx.getImageData(60, 30, 40, 30).data;
    let hit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i + 1] > 180 && d[i] < 90 && d[i + 2] < 90) hit++;
    return hit / (40 * 30);
  });
}

test("Vibe：第一輪程式有錯 → 沙盒抓到並回饋 → 第二輪通過，特效加到時間軸並畫出來", async ({ page }) => {
  const bodies: Record<string, unknown>[] = [];
  let round = 0;
  await page.route(`${GATEWAY}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return reply(route, 204);
    expect(req.headers()["authorization"]).toBe("Bearer test-token");
    if (req.method() === "POST" && req.url().endsWith("/v1/ai/vibe")) {
      bodies.push(req.postDataJSON());
      round = 1;
      return reply(route, 202, { jobId: "job-1" });
    }
    if (req.method() === "POST" && req.url().endsWith("/feedback")) {
      bodies.push(req.postDataJSON());
      round = 2;
      return reply(route, 202);
    }
    // 第一輪：插件程式少了右括號（編譯錯）；第二輪：正確的綠點＋內建箭頭
    const broken = { ...GREEN_DOT, code: GREEN_DOT.code.slice(0, -1) };
    const result = {
      refusal: null, mode: "compose", targetPhrase: "",
      anim: { title: "Green dot", layers: [{ component: "#0", params: {} }, ...(round === 2 ? [{ component: "arrow", params: {} }] : [])], sounds: [] },
      components: [round === 1 ? broken : GREEN_DOT],
    };
    return reply(route, 200, { status: "done", round, result, error: null });
  });

  await setup(page, "A green dot in the middle");
  await page.getByTestId("vibe-generate").click();
  // 第一次用：同意說明
  await expect(page.getByTestId("vibe-consent")).toBeVisible();
  await page.getByRole("button", { name: "Agree and continue" }).click();

  await expect(page.locator(".effect-chip")).toHaveCount(1, { timeout: 20_000 });
  await expect(page.getByTestId("vibe-error")).toHaveCount(0);
  // 送出的內容：描述、截圖（JPEG data URL）、1080p 虛擬座標的目標框
  expect(bodies[0]).toMatchObject({ description: "A green dot in the middle", fps: 30, width: 1920, box: { x: 672, y: 432, w: 576, h: 216 } });
  expect(String(bodies[0].screenshot)).toMatch(/^data:image\/jpeg;base64,/);
  // 回饋：第 0 個插件的編譯錯誤（帶行號）
  const errors = (bodies[1] as { errors: { stage: string; component: number; line: number }[] }).errors;
  expect(errors[0]).toMatchObject({ stage: "compile", component: 0 });
  expect(errors[0].line).toBeGreaterThan(0);

  // 畫出來：播放頭移到特效中間，中央有綠色
  await page.locator(".ruler").click({ position: { x: 25, y: 5 } });
  await expect.poll(() => greenRatio(page), { timeout: 10_000 }).toBeGreaterThan(0.2);
  await expect(page.locator(".effect-chip")).toContainText("Green dot");
});

test("Vibe：拒答顯示固定文字，不顯示模型的文字", async ({ page }) => {
  await page.route(`${GATEWAY}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "POST") return reply(route, 202, { jobId: "job-2" });
    return reply(route, 200, { status: "done", round: 1, result: { refusal: "off-topic", mode: null, anim: null, components: [], targetPhrase: "" }, error: null });
  });
  await page.addInitScript(() => localStorage.setItem("wordblade.consent.vibe", "yes"));
  await setup(page, "Write me a poem about the sea");
  await page.getByTestId("vibe-generate").click();
  await expect(page.getByTestId("vibe-error")).toContainText("doesn't look like an on-screen effect");
  await expect(page.locator(".effect-chip")).toHaveCount(0);
});

test("Vibe：權杖錯誤時提示檢查 AI 設定", async ({ page }) => {
  await page.route(`${GATEWAY}/**`, (route) => reply(route, 401, { error: "unauthorized" }));
  await page.addInitScript(() => localStorage.setItem("wordblade.consent.vibe", "yes"));
  await setup(page, "A red box");
  await page.getByTestId("vibe-generate").click();
  await expect(page.getByTestId("vibe-error")).toContainText("invite token isn't valid");
});
