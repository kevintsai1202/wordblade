import { expect, test } from "@playwright/test";
import path from "node:path";
import { parentCsp } from "../deploy/csp.mjs";
import { openTab } from "./helpers/tabs";

// 父頁 CSP（spec §5.7，2026-11-01）：vite preview 和 nginx 送同一份 CSP（deploy/csp.mjs）。
// 匯入影片 → 加帶音效的 2D 範本（沙盒 iframe＋Worker）→ 播放預覽 → 匯出，整段不能有任何 CSP 違規。
const FIXTURES = path.join(import.meta.dirname, "fixtures");

test("父頁 CSP：首頁帶 CSP 標頭，匯入、2D 特效、預覽、匯出都沒有違規", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.setItem("wordblade.exportToOpfs", "1");
    localStorage.setItem("wordblade.dev", "1");
    // 收集 CSP 違規（被擋的指令與網址）
    const list: string[] = [];
    (window as unknown as { __cspViolations: string[] }).__cspViolations = list;
    document.addEventListener("securitypolicyviolation", (e) => list.push(`${e.effectiveDirective} ${e.blockedURI}`));
  });
  const res = await page.goto("/");
  expect(res!.headers()["content-security-policy"]).toBe(parentCsp());

  await page.setViewportSize({ width: 1600, height: 1000 });
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "gaps.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "gaps.mp4" }).dblclick();
  await page.locator(".ruler").click({ position: { x: 1 + 2 * 20, y: 5 } });
  await openTab(page, "vibe");
  await page.locator('[data-template="box-ding"]').click();
  // 沙盒算出特效音效＝iframe 與 Worker 都在 CSP 下跑起來了
  await expect(page.locator("canvas[data-fx-sounds]")).toHaveAttribute("data-fx-sounds", "1", { timeout: 20_000 });

  // 預覽播一下
  await page.keyboard.press("Space");
  await page.waitForTimeout(1500);
  await page.keyboard.press("Space");

  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 90_000 });

  const violations = await page.evaluate(() => (window as unknown as { __cspViolations: string[] }).__cspViolations);
  expect(violations).toEqual([]);
});
