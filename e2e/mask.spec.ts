import { expect, test, type Page, type Route } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// SAM 遮罩（spec §5.3）的介面流程，閘道由 Playwright 攔截（不連真的 SAM）：重播 2026-10-28 實測串流（FOSDEM 講者 40 格，
// 框在畫面右下約 x 0.78～0.85、y 0.80～0.95）當作 talk.mp4 前 4 秒的結果 → 遮罩物件出現在清單 → 改成純色橘色 →
// 預覽與匯出的 MP4 那一塊是橘色 → 關掉就沒有 → Ctrl+Z 回來。小檔真的在瀏覽器裡轉（mediabunny＋WebCodecs）。
const GATEWAY = "https://gateway.test";
const FIXTURES = path.join(import.meta.dirname, "fixtures");
const OUT = path.join(import.meta.dirname, "..", "output", "e2e-mask");
/** 實測串流的逐格輸出（一格一行） */
const LINES = readFileSync(path.join(import.meta.dirname, "..", "src", "sam", "fixtures", "fosdem-person.sse"), "utf8")
  .split(/\r?\n/).filter((l) => l.startsWith("data:") && l.includes("output_text.delta"))
  .map((l) => JSON.parse(l.slice(5)).delta as string).join("").split("\n").filter(Boolean);

/** 回應（帶 CORS 標頭） */
async function reply(route: Route, status: number, body?: unknown) {
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
  return route.fulfill({ status, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body) });
}

/** 預覽畫面在遮罩框裡橘色像素的比例（talk.mp4 是 testsrc2，那一塊原本是洋紅，彩條裡沒有橘色） */
async function orangeInBox(page: Page): Promise<number> {
  return page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const p = document.createElement("canvas");
    p.width = 320;
    p.height = 180;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 320, 180);
    const d = ctx.getImageData(Math.round(320 * 0.79), Math.round(180 * 0.82), Math.round(320 * 0.05), Math.round(180 * 0.1)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 90 && d[i + 1] < 170 && d[i + 2] < 70) n++;
    return n / (d.length / 4);
  });
}

test("遮罩：找人 → 清單 → 純色橘色 → 預覽與匯出都遮住 → 關掉沒有 → 復原", async ({ page }) => {
  test.setTimeout(150_000);
  const posts: string[] = [];
  await page.route(`${GATEWAY}/**`, async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.url().endsWith("/v1/sam")) {
      posts.push(req.postDataBuffer()?.includes("name=\"prompt\"\r\n\r\nperson") ? "person" : "?");
      return reply(route, 202, { jobId: "s1" });
    }
    if (req.method() === "GET" && req.url().includes("/v1/sam/s1")) return reply(route, 200, { status: "done", lines: LINES, next: LINES.length, framesProcessed: 50, error: null });
    return reply(route, 204);
  });
  await page.addInitScript((url) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "test-token" }));
    localStorage.setItem("wordblade.consent.sam", "yes");
    localStorage.setItem("wordblade.exportToOpfs", "1");
  }, GATEWAY);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();

  // 遮罩之前那一塊沒有橘色
  await page.locator(".ruler").click({ position: { x: 21, y: 5 } });
  await expect.poll(() => orangeInBox(page)).toBeLessThan(0.05);
  await openTab(page, "mask");
  await expect(page.getByTestId("mask-range")).toContainText("40 frames");
  await page.locator('[data-phrase="person"]').click();
  await page.getByTestId("mask-find").click();
  await expect(page.getByTestId("mask-row")).toHaveCount(1, { timeout: 60_000 });
  expect(posts).toEqual(["person"]);
  await expect(page.getByTestId("mask-message")).toContainText('Found 1 × "person"');

  // 純色橘色：預覽 1 秒處那一塊變橘色
  await page.getByTestId("mask-effect").selectOption("solid");
  await page.getByTestId("mask-color").evaluate((el: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, "#ff8000");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator(".ruler").click({ position: { x: 21, y: 5 } });
  await expect.poll(() => orangeInBox(page), { timeout: 15_000 }).toBeGreaterThan(0.3);
  await page.screenshot({ path: "output/ui-shots/mask-solid.png" });

  // 匯出的 MP4：1 秒處同一塊也是橘色
  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 60_000 });
  const b64 = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, "masked.mp4");
  writeFileSync(file, Buffer.from(b64, "base64"));
  const px = spawnSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", file, "-frames:v", "1", "-vf", "crop=iw*0.05:ih*0.1:iw*0.79:ih*0.82", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]).stdout as Buffer;
  let orange = 0;
  for (let i = 0; i < px.length; i += 3) if (px[i] > 200 && px[i + 1] > 90 && px[i + 1] < 170 && px[i + 2] < 70) orange++;
  expect(orange / (px.length / 3)).toBeGreaterThan(0.3);

  // 關掉：那一塊不再是橘色；Ctrl+Z 回來
  await openTab(page, "mask");
  await page.getByTestId("mask-enabled").uncheck();
  await expect.poll(() => orangeInBox(page), { timeout: 15_000 }).toBeLessThan(0.05);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect.poll(() => orangeInBox(page), { timeout: 15_000 }).toBeGreaterThan(0.3);
});

// 螢幕文字類個資（開發者 2026-10-28）：SAM 分割不出文字，「API keys」這類目標交給 Muse Spark 每秒 1 格找框（閘道攔截）→ 長方形遮罩
test("文字類目標（API keys）走 Spark 定位：每秒 1 格送出 → 長方形遮罩 → 預覽那一塊遮住", async ({ page }) => {
  test.setTimeout(120_000);
  /** 送出的各格時間 */
  let times: number[] = [];
  let sam = 0;
  await page.route(`${GATEWAY}/**`, async (route) => {
    const req = route.request();
    if (req.url().includes("/v1/sam")) sam++;
    if (req.method() === "POST" && req.url().endsWith("/v1/ai/locate")) {
      const body = req.postDataBuffer()!.toString("latin1");
      times = JSON.parse(/name="times"\r\n\r\n(\[[^\]]*\])/.exec(body)![1]);
      // 和真的閘道一樣：空的畫面回 400（片尾取不到畫面時前端要先濾掉）
      const sizes = [...body.matchAll(/Content-Type: image\/jpeg\r\n\r\n([\s\S]*?)\r\n--/g)].map((m) => m[1].length);
      if (sizes.length !== times.length || sizes.some((n) => n === 0)) return reply(route, 400, { error: "bad-request" });
      return reply(route, 202, { jobId: "l1" });
    }
    if (req.method() === "GET" && req.url().includes("/v1/ai/locate/l1")) {
      return reply(route, 200, { status: "done", error: null, frames: times.map((t) => ({ t, items: [{ text: "sk-test", x: 0.79, y: 0.82, w: 0.05, h: 0.1 }] })) });
    }
    return reply(route, 204);
  });
  await page.addInitScript((url) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "test-token" }));
    localStorage.setItem("wordblade.consent.sam", "yes");
  }, GATEWAY);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();

  await openTab(page, "mask");
  await page.locator('[data-phrase="API key"]').click();
  await expect(page.getByTestId("mask-range")).toContainText("frames to Muse Spark");
  await page.getByTestId("mask-find").click();
  await expect(page.getByTestId("mask-row")).toHaveCount(1, { timeout: 60_000 });
  expect(sam).toBe(0);
  // talk.mp4 只有 4 秒：4 秒那格取不到畫面，不送
  expect(times.length).toBeGreaterThanOrEqual(4);
  expect(times.slice(0, 4)).toEqual([0, 1, 2, 3]);
  await expect(page.getByTestId("mask-row")).toHaveAttribute("data-shape", "rect");
  await page.getByTestId("mask-effect").selectOption("solid");
  await page.getByTestId("mask-color").evaluate((el: HTMLInputElement) => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(el, "#ff8000");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.locator(".ruler").click({ position: { x: 41, y: 5 } });
  await expect.poll(() => orangeInBox(page), { timeout: 15_000 }).toBeGreaterThan(0.3);
});

