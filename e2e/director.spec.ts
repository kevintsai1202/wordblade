import { expect, test, type Page, type Route } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { transcribed } from "./helpers/transcribed";
import { openTab } from "./helpers/tabs";

// AI 導演（spec §5.11）的介面流程，閘道由 Playwright 攔截（不連真的 AI）：talk.mp4（4 秒，假轉錄 Hello world. / Again.）
// → Ask the director（真的在瀏覽器轉 480p 小檔、上傳；假閘道從上傳的詞拿 id）→ 六種建議 → 採用改字、放大、遮罩（重播 SAM 實測串流）、
// Esc 略過特效（範圍不被清掉）、採用剪 → Ctrl+Z 只回復剪的那一步。特效與運鏡的採用要真的 AI，在實機測。
const GATEWAY = "http://fake-gateway.test";
/** SAM 實測串流的逐格輸出 */
const SAM_LINES = readFileSync(path.join(import.meta.dirname, "..", "src", "sam", "fixtures", "fosdem-person.sse"), "utf8")
  .split(/\r?\n/).filter((l) => l.startsWith("data:") && l.includes("output_text.delta"))
  .map((l) => JSON.parse(l.slice(5)).delta as string).join("").split("\n").filter(Boolean);

/** 回應（帶 CORS 標頭） */
async function reply(route: Route, status: number, body?: unknown) {
  const headers = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type, authorization", "access-control-allow-methods": "GET, POST, DELETE, OPTIONS" };
  if (route.request().method() === "OPTIONS") return route.fulfill({ status: 204, headers });
  return route.fulfill({ status, headers: { ...headers, "content-type": "application/json" }, body: body === undefined ? "" : JSON.stringify(body) });
}

/** 時間軸總長（秒，30 fps 時間碼） */
async function edited(page: Page): Promise<number> {
  const code = (await page.locator(".transport").innerText()).match(/Edited\s+(\d+):(\d+):(\d+):(\d+)/)!;
  const [h, m, s, f] = code.slice(1).map(Number);
  return h * 3600 + m * 60 + s + f / 30;
}

test("AI 導演：建議清單 → 採用改字、放大、遮罩，Esc 略過，採用剪再 Ctrl+Z", async ({ page }) => {
  test.setTimeout(150_000);
  /** 上傳的段落帶來的詞 id */
  let wordIds: string[] = [];
  let uploads = 0;
  await page.route(`${GATEWAY}/v1/ai/director**`, async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.url().endsWith("/v1/ai/director")) return reply(route, 202, { jobId: "d1" });
    if (req.method() === "POST" && req.url().includes("/segments/")) {
      uploads++;
      const body = req.postDataBuffer()!.toString("latin1");
      wordIds = [...body.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]);
      return reply(route, 202);
    }
    if (req.method() === "GET") {
      return reply(route, 200, {
        status: "done", segmentsDone: 1, segmentsTotal: 1, segmentsFailed: 0, error: null, suggestions: [
          { kind: "fix", start: 0, end: 0.5, reason: "Misheard greeting", payload: { wordIds: [wordIds[0]], text: "Howdy" } },
          { kind: "camera", start: 0.2, end: 1.5, reason: "Intro", payload: { scene: "board-float", description: "Swing in" } },
          { kind: "zoom", start: 0.5, end: 2, reason: "Small text", payload: { cx: 0.3, cy: 0.3, w: 0.5 } },
          { kind: "mask", start: 1, end: 2, reason: "Person on screen", payload: { target: "person" } },
          { kind: "effect", start: 1.2, end: 2, reason: "Key point", payload: { description: "A pop of confetti" } },
          { kind: "cut", start: 2.4, end: 4, reason: "Retake", payload: {} },
        ],
      });
    }
    return reply(route, 204);
  });
  await page.route(`${GATEWAY}/v1/sam**`, async (route) => {
    const req = route.request();
    if (req.method() === "POST") return reply(route, 202, { jobId: "s1" });
    if (req.method() === "GET") return reply(route, 200, { status: "done", lines: SAM_LINES, next: SAM_LINES.length, framesProcessed: 50, error: null });
    return reply(route, 204);
  });
  await page.addInitScript(() => {
    for (const k of ["director", "sam", "vibe", "plane3d"]) localStorage.setItem(`wordblade.consent.${k}`, "yes");
  });
  await transcribed(page);

  await openTab(page, "director");
  await expect(page.getByTestId("director-estimate")).toContainText("k tokens");
  await page.getByTestId("director-ask").click();
  const rows = page.getByTestId("director-row");
  await expect(rows).toHaveCount(6, { timeout: 60_000 });
  expect(uploads).toBe(1);
  expect(wordIds.length).toBe(3);
  await expect(rows.first()).toHaveAttribute("data-kind", "fix");

  // 改字
  await page.locator('[data-kind="fix"] [data-testid="director-adopt"]').click();
  await expect(page.locator('[data-kind="fix"]')).toHaveAttribute("data-status", "applied");
  // 放大：V1 上出現放大條
  await page.locator('[data-kind="zoom"] [data-testid="director-adopt"]').click();
  await expect(page.locator(".zoomband")).toHaveCount(1);
  // 遮罩：真的轉 SAM 小檔、重播實測串流 → 遮罩物件
  await page.locator('[data-kind="mask"] [data-testid="director-adopt"]').click();
  await expect(page.locator('[data-kind="mask"]')).toHaveAttribute("data-status", "applied", { timeout: 60_000 });
  // 特效：點選（跳過去、選範圍）→ Esc 略過；範圍還在
  await page.locator('[data-kind="effect"]').click();
  await expect(page.getByTestId("range-actions")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-kind="effect"]')).toHaveAttribute("data-status", "skipped");
  await expect(page.getByTestId("range-actions")).toBeVisible();
  await page.screenshot({ path: "output/ui-shots/director.png" });
  // 剪：片子變短；Ctrl+Z 只回復剪
  const before = await edited(page);
  await page.locator('[data-kind="cut"] [data-testid="director-adopt"]').click();
  await expect.poll(() => edited(page)).toBeLessThan(before - 1);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  await expect.poll(() => edited(page)).toBeCloseTo(before, 1);
  await expect(page.locator('[data-kind="cut"]')).toHaveAttribute("data-status", "pending");
  await expect(page.locator('[data-kind="mask"]')).toHaveAttribute("data-status", "applied");
  // 其他頁籤看得到結果：逐字稿改了字、遮罩清單有物件
  await openTab(page, "transcript");
  await expect(page.locator(".transcript")).toContainText("Howdy");
  await openTab(page, "mask");
  await expect(page.getByTestId("mask-row")).toHaveCount(1);
});
