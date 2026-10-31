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
  /** 收到審查（縮圖總表）了沒 */
  let reviewed = false;
  let sheetSent = false;
  /** 建工作時送的風格、規劃前有沒有送畫面總表（docs/plan-10-30-director3.md） */
  let style = "";
  let framesSent = false;
  await page.route(`${GATEWAY}/v1/ai/director**`, async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.url().endsWith("/v1/ai/director")) {
      style = JSON.parse(req.postData() ?? "{}").style;
      return reply(route, 202, { jobId: "d1" });
    }
    if (req.method() === "POST" && req.url().endsWith("/frames")) {
      framesSent = uploads === 0;
      return reply(route, 202);
    }
    if (req.method() === "POST" && req.url().includes("/segments/")) {
      uploads++;
      const body = req.postDataBuffer()!.toString("latin1");
      wordIds = [...body.matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]).filter((id) => !/^a\d/.test(id));
      return reply(route, 202);
    }
    if (req.method() === "POST" && req.url().endsWith("/review")) {
      reviewed = true;
      sheetSent = req.postDataBuffer()!.toString("latin1").includes('name="sheet"');
      return reply(route, 202);
    }
    if (req.method() === "GET") {
      // 規劃完先 planned，收到縮圖總表審查後 done（docs/plan-10-29-director2.md）
      const it = (id: string, kind: string, start: number, end: number, chapter: number, purpose: string, payload: Record<string, unknown>, verdict = "keep") =>
        ({ id, kind, start, end, chapter, reason: purpose, purpose, quote: "Hello world.", payload, review: reviewed ? { verdict, note: verdict === "keep" ? "ok" : "moved" } : null });
      const items = [
        it("i1", "fix", 0, 0.5, 0, "Misheard greeting", { wordIds: [wordIds[0]], text: "Howdy" }),
        it("i2", "transition", 0.2, 1.5, 0, "Open the video", { scene: "board-float" }),
        it("i3", "zoom", 0.5, 2, 0, "Small text", { cx: 0.3, cy: 0.3, w: 0.5 }, "revised"),
        it("i4", "mask", 1, 2, 0, "Person on screen", { target: "person" }),
        it("i5", "effect", 1.2, 2, 0, "Key point", { description: "A pop of confetti" }),
        it("i6", "cut", 2.4, 4, 1, "Retake", {}, "prune"),
        it("n1", "note", 3, 4, 1, "At 3.0 s the speaker adds something left out at 0.5 s; both are kept.", { relation: "supplement", earlierStart: 0.5 }),
      ];
      const chapters = [{ title: "Greeting", start: 0, end: 2.4 }, { title: "Again", start: 2.4, end: 4 }];
      const treatment = { audience: "beginners", problems: [{ id: "p1", start: 0.5, end: 2, what: "Small text on the slide" }] };
      if (!reviewed) return reply(route, 200, { status: "planned", segmentsDone: 1, segmentsTotal: 1, segmentsFailed: 0, error: null, chapters, suggestions: items, removed: [] });
      return reply(route, 200, {
        status: "done", segmentsDone: 1, segmentsTotal: 1, segmentsFailed: 0, error: null, chapters, suggestions: items, treatment,
        removed: [it("i7", "mascot", 3, 4, 1, "Wave", { x: 0.5, y: 0.5, w: 0.1, h: 0.1 }, "drop")],
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
  await expect(rows).toHaveCount(8, { timeout: 60_000 });
  expect(uploads).toBe(1);
  // 送了縮圖總表給審查者；依章節分組、審查刪掉的吉祥物灰色列在最後（略過狀態）、改過的有標記
  expect(sheetSent).toBe(true);
  // 預設風格 plain；規劃前（第一段上傳前）送了畫面總表；審查員點名可刪的剪預設不勾；顯示導演構想
  expect(style).toBe("plain");
  expect(framesSent).toBe(true);
  await expect(page.locator('[data-kind="cut"] [data-testid="director-check"]')).not.toBeChecked();
  await expect(page.locator('[data-kind="cut"]')).toContainText("could go");
  await expect(page.getByTestId("director-treatment")).toContainText("beginners");
  // 補充的提醒（docs/plan-10-31-director4.md）：只顯示，沒有勾選框與 Apply；Dismiss 標成略過
  const note = page.locator('[data-kind="note"]');
  await expect(note).toContainText("left out at 0.5 s");
  await expect(note.getByTestId("director-check")).toHaveCount(0);
  await expect(note.getByTestId("director-adopt")).toHaveCount(0);
  await expect(page.getByTestId("director-apply-checked")).toContainText("Apply 5 checked");
  await expect(page.getByTestId("director-chapter")).toHaveCount(3);
  await expect(page.locator('[data-kind="mascot"]')).toHaveAttribute("data-status", "skipped");
  await expect(page.locator('[data-kind="zoom"]')).toContainText("revised by review");
  await expect(page.locator('[data-kind="cut"]')).toContainText("Hello world.");
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

test("AI 導演：勾選的項目一次套用（改字、放大、剪、字幕樣式），一次 Ctrl+Z 全部回來；沒勾的不套", async ({ page }) => {
  test.setTimeout(150_000);
  let wordIds: string[] = [];
  let reviewed = false;
  await page.route(`${GATEWAY}/v1/ai/director**`, async (route) => {
    const req = route.request();
    if (req.method() === "POST" && req.url().endsWith("/v1/ai/director")) return reply(route, 202, { jobId: "d2" });
    if (req.method() === "POST" && req.url().includes("/segments/")) {
      wordIds = [...req.postDataBuffer()!.toString("latin1").matchAll(/"id":"([^"]+)"/g)].map((m) => m[1]).filter((id) => !/^a\d/.test(id));
      return reply(route, 202);
    }
    if (req.method() === "POST" && req.url().endsWith("/review")) { reviewed = true; return reply(route, 202); }
    if (req.method() === "GET") {
      const it = (id: string, kind: string, start: number, end: number, chapter: number, payload: Record<string, unknown>) =>
        ({ id, kind, start, end, chapter, reason: "r", purpose: `purpose ${id}`, quote: "Hello world.", payload, review: { verdict: "keep", note: "ok" } });
      const items = [
        it("i1", "fix", 0, 0.5, 0, { wordIds: [wordIds[0]], text: "Howdy" }),
        it("i2", "zoom", 0.5, 2, 0, { cx: 0.3, cy: 0.3, w: 0.5 }),
        it("i3", "cut", 2.4, 4, 0, {}),
        it("i4", "captionStyle", 0, 4, -1, { karaoke: "box" }),
      ];
      return reply(route, 200, { status: reviewed ? "done" : "planned", segmentsDone: 1, segmentsTotal: 1, segmentsFailed: 0, error: null, chapters: [{ title: "All", start: 0, end: 4 }], suggestions: items, removed: [] });
    }
    return reply(route, 204);
  });
  await page.addInitScript(() => { for (const k of ["director", "sam", "vibe", "plane3d"]) localStorage.setItem(`wordblade.consent.${k}`, "yes"); });
  await transcribed(page);
  await openTab(page, "director");
  await page.getByTestId("director-ask").click();
  await expect(page.getByTestId("director-row")).toHaveCount(4, { timeout: 60_000 });
  // 不要剪：取消勾選
  await page.locator('[data-kind="cut"] [data-testid="director-check"]').uncheck();
  await expect(page.getByTestId("director-apply-checked")).toHaveText("Apply 3 checked");
  const before = await edited(page);
  await page.getByTestId("director-apply-checked").click();
  for (const kind of ["fix", "zoom", "captionStyle"]) await expect(page.locator(`[data-kind="${kind}"]`)).toHaveAttribute("data-status", "applied");
  await expect(page.locator('[data-kind="cut"]')).toHaveAttribute("data-status", "pending");
  await expect(page.locator(".zoomband")).toHaveCount(1);
  expect(await edited(page)).toBeCloseTo(before, 1);
  // 一次 Ctrl+Z：三項都回到未採用
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  await page.keyboard.press("Control+z");
  for (const kind of ["fix", "zoom", "captionStyle"]) await expect(page.locator(`[data-kind="${kind}"]`)).toHaveAttribute("data-status", "pending");
  await expect(page.locator(".zoomband")).toHaveCount(0);
});
