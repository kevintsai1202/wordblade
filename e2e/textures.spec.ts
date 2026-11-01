import { expect, test, type Page, type Route } from "@playwright/test";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// Muse Image 材質圖與 3D 背景（spec §5.12，P1-14）的介面流程：描述 → 閘道（假的，由 Playwright 攔截）→ 本機後處理 → 材質庫 →
// Inspector 把材質套到教室牆壁 → 3D 沙盒把材質畫在預覽上。
const GATEWAY = "https://gateway.test";
const FIXTURES = path.join(import.meta.dirname, "fixtures");

/** 回應（含 CORS 標頭；預檢一律放行） */
async function reply(route: Route, status: number, body?: unknown) {
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
  return route.fulfill({ status, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body) });
}

/** 在瀏覽器裡畫一張 256×256 的紅藍棋盤格（假閘道回的圖），回傳 PNG 的 base64 */
async function checkerPng(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const c = new OffscreenCanvas(256, 256);
    const g = c.getContext("2d")!;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      g.fillStyle = (x + y) % 2 ? "#e02020" : "#2030e0";
      g.fillRect(x * 32, y * 32, 32, 32);
    }
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  });
}

/** 預覽畫面縮成 80×45 的像素（用來比對畫面有沒有變） */
async function preview(page: Page): Promise<number[]> {
  return page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const p = document.createElement("canvas");
    p.width = 80;
    p.height = 45;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 80, 45);
    return [...ctx.getImageData(0, 0, 80, 45).data];
  });
}

/** 兩張畫面的平均差（0～255） */
function meanDiff(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

test("材質：產生 → 材質庫（不在素材庫列出）→ 套到教室牆壁 → 預覽畫面變了", async ({ page }) => {
  test.setTimeout(150_000);
  page.on("console", (m) => { if (m.type() === "error") console.log(`[console.error] ${m.text()}`); });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const image = await checkerPng(page);

  // 假閘道：POST 收下描述（記起來），GET 回固定的棋盤格圖
  const posts: string[] = [];
  await page.route(`${GATEWAY}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return reply(route, 204);
    expect(req.headers()["authorization"]).toBe("Bearer test-token");
    if (req.method() === "POST" && req.url().endsWith("/v1/ai/image")) {
      posts.push(req.postData() ?? "");
      return reply(route, 202, { jobId: `job-${posts.length}` });
    }
    return reply(route, 200, { status: "done", image, mime: "image/png", error: null });
  });
  await page.evaluate((url) => localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "test-token" })), GATEWAY);
  await page.reload();

  // V1 放一段影片
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();

  // 產生一張材質：先出現同意說明（提到 Muse Image 與 Meta）
  await openTab(page, "textures");
  await page.getByTestId("texture-description").fill("worn oak planks");
  await page.getByTestId("texture-generate").click();
  await expect(page.getByTestId("texture-consent")).toContainText("Muse Image");
  await expect(page.getByTestId("texture-consent")).toContainText("Meta");
  await page.getByRole("button", { name: "Agree and continue" }).click();
  await expect(page.getByTestId("texture-item")).toHaveCount(1, { timeout: 60_000 });
  expect(posts).toHaveLength(1);
  expect(posts[0]).toContain('name="purpose"');
  expect(posts[0]).toContain("texture");
  expect(posts[0]).toContain("worn oak planks");
  expect(posts[0]).not.toContain('name="image"');
  // 預覽是 2×2 拼貼（背景圖縮成一半）
  await expect(page.getByTestId("texture-preview")).toHaveCSS("background-size", /50%/);
  await expect(page.getByTestId("texture-strength")).toBeVisible();

  // 材質的兩張圖不列在素材庫
  await openTab(page, "media");
  await expect(page.locator(".media-item")).toHaveCount(1);
  await expect(page.locator(".media-item .media-name")).toHaveText("talk.mp4");

  // 3D 範本「教室黑板」加在 0 秒，播放頭移到中段，等場景畫出來
  await openTab(page, "vibe3d");
  await page.locator('[data-template="classroom-board"]').click();
  await expect(page.locator(".effect-chip")).toHaveCount(1);
  await page.locator(".ruler").click({ position: { x: 60, y: 5 } });
  // 預設的牆是米色：還沒有紅藍棋盤格
  // 紅或藍的像素數（只看左邊 20 欄的牆面與地板，避開中間播影片的螢幕：testsrc2 本身就很多彩）
  const redBlue = async () => (await preview(page)).reduce((n, _, i, d) => {
    if (i % 4 !== 0 || (i / 4) % 80 >= 20) return n;
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    return (r > 120 && g < 90 && b < 90) || (b > 120 && r < 90 && g < 90) ? n + 1 : n;
  }, 0);
  // 左邊 20 欄裡明亮（牆是米色）的像素數：場景真的畫出來了才算（還沒畫時畫布是黑的或還是影片）
  const bright = async () => (await preview(page)).reduce((n, _, i, d) => (i % 4 === 0 && (i / 4) % 80 < 20 && d[i] > 150 && d[i + 1] > 140 && d[i + 2] > 100 ? n + 1 : n), 0);
  await expect.poll(bright, { timeout: 60_000 }).toBeGreaterThan(150);
  await expect.poll(redBlue, { timeout: 30_000 }).toBeLessThan(20);
  const before = await preview(page);

  // Inspector：牆的材質選剛產生的那張
  await page.locator(".effect-chip").click();
  await openTab(page, "inspector");
  const wall = page.locator('[data-param="wallTexture"] [data-testid="param-texture"]');
  await expect(wall.locator("option")).toHaveText(["Default", "worn oak planks", "Generate a new one…"]);
  // 背景圖的下拉只列 3D 背景（目前沒有）
  await expect(page.locator('[data-param="backgroundImage"] [data-testid="param-texture"] option')).toHaveText(["Default", "Generate a new one…"]);
  await wall.selectOption({ label: "worn oak planks" });

  // 預覽畫面變了：牆上出現紅藍棋盤格
  await expect.poll(async () => meanDiff(before, await preview(page)), { timeout: 60_000 }).toBeGreaterThan(8);
  await expect.poll(redBlue, { timeout: 30_000 }).toBeGreaterThan(100);
  await page.screenshot({ path: "output/ui-shots/texture-classroom.png" });

  // 選回 Default：回到米色的牆
  await wall.selectOption({ label: "Default" });
  await expect.poll(redBlue, { timeout: 60_000 }).toBeLessThan(20);
  await wall.selectOption({ label: "worn oak planks" });
  await expect.poll(redBlue, { timeout: 60_000 }).toBeGreaterThan(100);

  // 「Generate a new one…」切到 Textures 頁籤
  await wall.selectOption({ label: "Generate a new one…" });
  await expect(page.getByTestId("texture-tab")).toBeVisible();

  // 再產生：同一個項目換新圖（請求兩次、項目還是一個），套在牆上的材質仍在
  await page.getByTestId("texture-regenerate").click();
  await expect.poll(() => posts.length, { timeout: 60_000 }).toBe(2);
  await expect(page.getByTestId("texture-item")).toHaveCount(1);
  await expect(page.getByTestId("texture-regenerate")).toBeEnabled({ timeout: 60_000 });
  await expect.poll(redBlue, { timeout: 60_000 }).toBeGreaterThan(100);
  // 素材庫仍然只有影片
  await openTab(page, "media");
  await expect(page.locator(".media-item")).toHaveCount(1);

  // 刪除：項目拿掉，牆回到預設；Ctrl+Z 一次全部回來
  await openTab(page, "textures");
  await page.getByTestId("texture-delete").click();
  await expect(page.getByTestId("texture-item")).toHaveCount(0);
  await expect.poll(redBlue, { timeout: 60_000 }).toBeLessThan(20);
  await page.locator(".title-bar").click();
  await page.keyboard.press("Control+z");
  await expect(page.getByTestId("texture-item")).toHaveCount(1);
  await expect.poll(redBlue, { timeout: 60_000 }).toBeGreaterThan(100);
});

test("3D 背景：選「3D background」產生，請求帶 purpose=background，項目是整張縮圖", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const image = await checkerPng(page);
  const posts: string[] = [];
  await page.route(`${GATEWAY}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return reply(route, 204);
    if (req.method() === "POST") {
      posts.push(req.postData() ?? "");
      return reply(route, 202, { jobId: "job-bg" });
    }
    return reply(route, 200, { status: "done", image, mime: "image/png", error: null });
  });
  await page.evaluate((url) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "test-token" }));
    localStorage.setItem("wordblade.consent.texture", "yes");
  }, GATEWAY);
  await page.reload();
  await openTab(page, "textures");
  await page.getByTestId("texture-kind").selectOption("background");
  await page.getByTestId("texture-description").fill("a cozy classroom with a chalkboard");
  await page.getByTestId("texture-generate").click();
  await expect(page.locator('[data-testid="texture-item"][data-kind="background"]')).toHaveCount(1, { timeout: 30_000 });
  expect(posts[0]).toContain("background");
  // 背景沒有法線強度滑桿
  await expect(page.getByTestId("texture-strength")).toHaveCount(0);

  // 套到漂浮的板子：背景選「AI image」＋剛產生的圖，中段板子縮小、露出的背景是紅藍棋盤格
  await openTab(page, "vibe3d");
  await page.locator('[data-template="board-float"]').click();
  await expect(page.locator(".effect-chip")).toHaveCount(1);
  await page.locator(".effect-chip").click();
  await openTab(page, "inspector");
  await page.locator('[data-param="background"] select').selectOption("image");
  await page.locator('[data-param="backgroundImage"] [data-testid="param-texture"]').selectOption({ label: "a cozy classroom with a chalkboard" });
  await page.locator(".ruler").click({ position: { x: 40, y: 5 } });
  // 只數左邊 12 欄（板子縮到 0.8 時露出的背景）裡的紅或藍
  const cornerRedBlue = async () => (await preview(page)).reduce((n, _, i, d) => {
    if (i % 4 !== 0 || (i / 4) % 80 >= 12) return n;
    const [r, g, b] = [d[i], d[i + 1], d[i + 2]];
    return (r > 120 && g < 90 && b < 90) || (b > 120 && r < 90 && g < 90) ? n + 1 : n;
  }, 0);
  await expect.poll(cornerRedBlue, { timeout: 60_000 }).toBeGreaterThan(80);
});

test("3D 背景方向不能顛倒：上半紅、下半藍的背景圖，預覽左邊露出的背景也是上紅下藍", async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  // 上半紅、下半藍
  const image = await page.evaluate(async () => {
    const c = new OffscreenCanvas(320, 180);
    const g = c.getContext("2d")!;
    g.fillStyle = "#e02020"; g.fillRect(0, 0, 320, 90);
    g.fillStyle = "#2030e0"; g.fillRect(0, 90, 320, 90);
    const bytes = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin);
  });
  await page.route(`${GATEWAY}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return reply(route, 204);
    if (req.method() === "POST") return reply(route, 202, { jobId: "job-up" });
    return reply(route, 200, { status: "done", image, mime: "image/png", error: null });
  });
  await page.evaluate((url) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "test-token" }));
    localStorage.setItem("wordblade.consent.texture", "yes");
  }, GATEWAY);
  await page.reload();
  await openTab(page, "textures");
  await page.getByTestId("texture-kind").selectOption("background");
  await page.getByTestId("texture-description").fill("sky over sea");
  await page.getByTestId("texture-generate").click();
  await expect(page.locator('[data-testid="texture-item"][data-kind="background"]')).toHaveCount(1, { timeout: 30_000 });
  await openTab(page, "vibe3d");
  await page.locator('[data-template="board-float"]').click();
  await page.locator(".effect-chip").click();
  await openTab(page, "inspector");
  await page.locator('[data-param="background"] select').selectOption("image");
  await page.locator('[data-param="backgroundImage"] [data-testid="param-texture"]').selectOption({ label: "sky over sea" });
  await page.locator(".ruler").click({ position: { x: 40, y: 5 } });
  /** 左邊 6 欄裡，上 8 列與下 8 列各自偏紅還是偏藍（紅 − 藍的平均） */
  const tilt = async () => {
    const d = await preview(page);
    const at = (rows: number[]) => {
      let sum = 0, n = 0;
      for (const y of rows) for (let x = 0; x < 6; x++) { const i = (y * 80 + x) * 4; sum += d[i] - d[i + 2]; n++; }
      return sum / n;
    };
    return { top: at([1, 2, 3, 4, 5, 6, 7, 8]), bottom: at([36, 37, 38, 39, 40, 41, 42, 43]) };
  };
  await expect.poll(async () => { const t = await tilt(); return t.top > 40 && t.bottom < -40; }, { timeout: 60_000 }).toBe(true);
});
