import { expect, test, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { transcribed } from "./helpers/transcribed";
import { openTab } from "./helpers/tabs";

// 發佈包（spec §5.17、§5.12）的介面流程，閘道由 Playwright 攔截（不連真的 AI）：
// talk.mp4 假轉錄 → Export › Publish Kit → 同意 → AI 寫好 3 個標題、說明、章節、標籤（4 秒的片章節不夠，提示沒有章節）→ 選第 2 個標題、
// 複製說明 → 縮圖用這一格（1280×720）→ AI 改風格（假閘道回一張 PNG）→ 匯出 MP4，旁邊多了 .publish.md（選中的標題在最前）與 .thumbnail.png。
const GATEWAY = "https://fake-gateway.test";
const CARD = readFileSync(path.join(import.meta.dirname, "fixtures", "card.png")).toString("base64");

/** 回應（帶 CORS 標頭） */
async function reply(route: Route, status: number, body?: unknown) {
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, OPTIONS" };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
  return route.fulfill({ status, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body) });
}

test("發佈包：AI 寫標題與說明 → 選標題、複製 → 縮圖 → 匯出時旁邊多了 publish.md 與 thumbnail.png", async ({ page, context }) => {
  test.setTimeout(150_000);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  /** 閘道收到的發佈包請求 */
  const sent: { language: string; duration: number; lines: { t: number; text: string }[] }[] = [];
  let imageParts = "";
  await page.route(`${GATEWAY}/v1/ai/publish**`, async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      sent.push(req.postDataJSON());
      return reply(route, 202, { jobId: "p1" });
    }
    if (req.method() === "GET") return reply(route, 200, {
      status: "done", error: null,
      kit: {
        titles: ["Say hello to WordBlade", "Hello world, edited by words", "Two lines, one cut"],
        description: "A tiny clip that says hello twice.", highlights: ["Hello", "Again"],
        chapters: [{ t: 0, title: "Hello" }, { t: 2.5, title: "Again" }], tags: ["wordblade", "demo"],
      },
    });
    return reply(route, 204);
  });
  await page.route(`${GATEWAY}/v1/ai/image**`, async (route) => {
    const req = route.request();
    if (req.method() === "POST") {
      imageParts = req.postDataBuffer()?.toString("latin1") ?? "";
      return reply(route, 202, { jobId: "i1" });
    }
    if (req.method() === "GET") return reply(route, 200, { status: "done", image: CARD, mime: "image/png", error: null });
    return reply(route, 204);
  });
  await transcribed(page);

  await openTab(page, "publish");
  await page.getByTestId("publish-generate").click();
  await expect(page.getByTestId("publish-consent")).toBeVisible();
  await page.getByRole("button", { name: "Agree and continue" }).click();
  await expect(page.getByTestId("publish-titles").locator("input[type=text]")).toHaveCount(3);
  // 送出去的是成片逐字稿（英文；詞級時間重建後兩句間隔不到 1 秒，併成一行）
  expect(sent[0]).toMatchObject({ language: "en", lines: [{ text: "Hello world. Again." }] });
  expect(sent[0].lines[0].t).toBeLessThan(0.5);
  // 4 秒的片：章節間隔不到 10 秒，YouTube 不顯示 → 不放章節並提示
  await expect(page.getByTestId("publish-notice")).toContainText("No chapters");

  // 選第 2 個標題、改說明、複製
  await page.getByTestId("publish-titles").locator("input[type=radio]").nth(1).check();
  await page.getByTestId("publish-description").fill("Hello twice, cut by words.");
  await page.getByTestId("copy-description").click();
  await expect(page.getByTestId("copy-description")).toHaveText("Copied");
  expect(await page.evaluate(() => navigator.clipboard.readText())).toContain("Hello twice, cut by words.");
  await page.getByTestId("copy-title").click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("Hello world, edited by words");

  // 縮圖：這一格 → 1280×720；再請 AI 改風格（送出 purpose 與風格描述）
  await page.locator(".ruler").click({ position: { x: 20, y: 5 } });
  await page.getByTestId("thumb-frame").click();
  await expect(page.getByTestId("thumb-preview")).toBeVisible();
  expect(await page.getByTestId("thumb-preview").evaluate((img: HTMLImageElement) => [img.naturalWidth, img.naturalHeight])).toEqual([1280, 720]);
  await page.getByTestId("thumb-style").fill("neon");
  await page.getByTestId("thumb-ai").click();
  await expect(page.getByTestId("thumb-ai")).toHaveText("Restyle with AI", { timeout: 20_000 });
  await expect(page.getByTestId("publish-error")).toHaveCount(0);
  expect(imageParts).toContain("thumbnail");
  expect(imageParts).toContain("neon");
  await page.screenshot({ path: "output/ui-shots/publish-kit.png" });

  // 匯出：MP4 旁邊多了 publish.md 與 thumbnail.png
  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 120_000 });
  await expect(page.getByTestId("export-status")).toContainText("publish kit");
  await expect(page.getByTestId("export-status")).toContainText("thumbnail");
  const files = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    const md = await (await (await dir.getFileHandle("wordblade-export.publish.md")).getFile()).text();
    const png = await createImageBitmap(await (await dir.getFileHandle("wordblade-export.thumbnail.png")).getFile());
    return { md, size: [png.width, png.height] };
  });
  expect(files.md.startsWith("# Hello world, edited by words\n")).toBe(true);
  expect(files.md).toContain("Hello twice, cut by words.");
  expect(files.md).toContain("wordblade, demo");
  expect(files.size).toEqual([1280, 720]);
});

test("發佈包：還沒轉錄時提示先轉錄", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await openTab(page, "publish");
  await expect(page.getByTestId("publish-hint")).toContainText("Transcribe");
});
