import { expect, test, type Page, type Route } from "@playwright/test";
import path from "node:path";

// 「用說的」（spec §5.8）：一句話 → AI 提議板子的運鏡（閘道回應由 Playwright 攔截）→ 預覽（不寫進專案）→ Discard／Apply，Apply 可以 Ctrl+Z 復原。
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const GATEWAY = "https://gateway.test";

/** 回應（含 CORS 標頭；預檢一律放行） */
async function reply(route: Route, status: number, body?: unknown) {
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
  return route.fulfill({ status, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body) });
}

/** 左上角的平均顏色（板子縮小時露出背景） */
function corner(page: Page) {
  return page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const p = document.createElement("canvas");
    p.width = 160;
    p.height = 90;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 160, 90);
    const d = ctx.getImageData(2, 2, 8, 6).data;
    let r = 0, g = 0, b = 0;
    for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
    const n = d.length / 4;
    return [r / n, g / n, b / n];
  });
}

test("用說的：提議 → 預覽 → Discard／Apply，Apply 可以復原", async ({ page }) => {
  test.setTimeout(90_000);
  const bodies: Record<string, unknown>[] = [];
  await page.route(`${GATEWAY}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return reply(route, 204);
    if (req.method() === "POST" && req.url().endsWith("/v1/ai/plane3d")) {
      bodies.push(req.postDataJSON());
      return reply(route, 202, { jobId: "p3-1" });
    }
    // 提議：從右邊轉進來、背景換成科技格線
    const proposal = { keys: [{ anchor: "start", t: 0, rx: 0, ry: 55, rz: 0, size: 0.55, px: 0.12, py: 0, ease: "inOut" }, { anchor: "start", t: 1.5, rx: 0, ry: 0, rz: 0, size: 0.6, px: 0, py: 0, ease: "inOut" }], background: "grid" };
    return reply(route, 200, { status: "done", round: 1, result: { refusal: null, proposal }, error: null });
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript((url) => localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "test-token" })), GATEWAY);
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  await page.locator('[data-tab="vibe"]').click();
  await page.locator('[data-template="board-float"]').click();
  const chip = page.locator(".effect-chip");
  await expect(chip).toHaveCount(1);
  await page.locator(".ruler").click({ position: { x: 50, y: 5 } });  // 2.5 秒：板子縮著
  await chip.click();
  await page.locator('[data-tab="inspector"]').click();

  // 攝影棚背景（藍 ≥ 紅、偏灰）
  await expect.poll(async () => { const [r, , b] = await corner(page); return b >= r && r > 20; }, { timeout: 60_000 }).toBe(true);
  await page.getByTestId("move-description").fill("Swing in from the right and use the tech grid background");
  await page.getByTestId("move-propose").click();
  await expect(page.getByTestId("move-consent")).toBeVisible();
  await page.getByRole("button", { name: "Agree and continue" }).click();

  // 預覽：背景變成科技格線（深藍，紅很低）；還沒寫進專案（沒有新的復原步驟）
  await expect(page.getByTestId("move-apply")).toBeVisible({ timeout: 15_000 });
  await expect.poll(async () => { const [r, , b] = await corner(page); return b > r + 15 && r < 25; }, { timeout: 30_000 }).toBe(true);
  expect(bodies[0]).toMatchObject({ description: "Swing in from the right and use the tech grid background", length: 5, width: 1920, height: 1080 });
  expect((bodies[0].current as { background: string }).background).toBe("studio");

  // Discard：回到攝影棚
  await page.getByTestId("move-discard").click();
  await expect.poll(async () => { const [r, , b] = await corner(page); return b >= r && r > 20; }, { timeout: 30_000 }).toBe(true);

  // 再提議一次並 Apply：寫進專案，Inspector 的背景變 grid；Ctrl+Z 復原回 studio
  await page.getByTestId("move-description").fill("Same again");
  await page.getByTestId("move-propose").click();
  await page.getByTestId("move-apply").click();
  await expect(page.locator('[data-param="background"] select')).toHaveValue("grid");
  await page.keyboard.press("Control+z");
  await expect(page.locator('[data-param="background"] select')).toHaveValue("studio");
});
