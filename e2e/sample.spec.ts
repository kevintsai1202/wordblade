import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// 範例專案（spec §5.22）：「Try the sample project」從靜態網站（public/sample/）載入預先算好的專案，
// 不用權杖、不呼叫 AI——對外連線全部擋掉也要能開、有字幕與特效、能匯出。
test("範例專案：離線也能開、有逐字稿與特效、可以匯出", async ({ page }) => {
  test.setTimeout(1_500_000);
  /** 擋掉的對外請求（應該一個都沒有） */
  const blocked: string[] = [];
  await page.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (route) => {
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript(() => localStorage.setItem("wordblade.exportToOpfs", "1"));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.getByTestId("load-sample").click();

  // V1：剪掉重講後的多段；導演 plain 風格（docs/plan-10-30-director3.md）沒有特效，改看放大條
  await expect.poll(() => page.locator('.track-row[data-track-id="V1"] .clip').count()).toBeGreaterThan(1);
  await expect.poll(() => page.locator(".zoomband").count()).toBeGreaterThan(2);
  await openTab(page, "transcript");
  await expect(page.getByText("meeting notes", { exact: false }).first()).toBeVisible();
  // 示範狀態：沒編輯前不自動存
  expect(await page.evaluate(() => localStorage.getItem("wordblade.session"))).toBeNull();

  // 匯出整支（2 分鐘，含 2D／3D 特效）
  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 1_400_000 });
  await expect(page.getByTestId("export-status")).not.toContainText("skipped");
  expect(blocked).toEqual([]);

  // 成片存一份到 output/sample-export.mp4（人工檢查 AI 剪出來的樣子）
  const b64 = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  mkdirSync(path.join(import.meta.dirname, "..", "output"), { recursive: true });
  writeFileSync(path.join(import.meta.dirname, "..", "output", "sample-export.mp4"), Buffer.from(b64, "base64"));
});

// 特效範例（2026-11-02）：同一支 2 分鐘影片，展示各種特效——AI 寫的 2D／3D 插件、3D 場景、內建範本、轉場、色彩、片頭、配樂。
// 不經過 AI 導演（導演是另一種能力，在導演範例），離線也要能開，而且每種特效都要在專案裡（避免重建時又不見）。
test("特效範例：離線也能開，2D／3D 插件、3D 場景、轉場、色彩、片頭、配樂都在，可以匯出", async ({ page }) => {
  test.setTimeout(1_500_000);
  const blocked: string[] = [];
  await page.route((url) => !["localhost", "127.0.0.1"].includes(url.hostname), (route) => {
    blocked.push(route.request().url());
    return route.abort();
  });
  await page.addInitScript(() => {
    localStorage.setItem("wordblade.dev", "1");
    localStorage.setItem("wordblade.exportToOpfs", "1");
  });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await page.getByTestId("load-sample-effects").click();
  await expect(page.locator(".effect-chip").first()).toBeVisible({ timeout: 30_000 });

  /** 專案內容摘要（開發鉤子） */
  const summary = await page.evaluate(() => {
    const p = (window as unknown as { __wordblade: { project: () => any } }).__wordblade.project();
    const count = (kind: string) => p.effects.filter((e: { kind: string }) => e.kind === kind).length;
    return {
      anim2d: count("anim2d"), anim3d: count("anim3d"), scene3d: count("scene3d"),
      vibe2d: p.plugins.filter((x: { source: string; kind: string }) => x.source === "vibe" && x.kind === "2d").length,
      vibe3d: p.plugins.filter((x: { source: string; kind: string }) => x.source === "vibe" && x.kind === "3d").length,
      cameraKeys: p.effects.filter((e: { kind: string; cameraKeys?: unknown[] }) => e.kind === "scene3d" && e.cameraKeys?.length).length, transitions: (p.transitions ?? []).length, kinds: new Set((p.transitions ?? []).map((t: { kind: string }) => t.kind)).size,
      grades: (p.colorGrades ?? []).length, synths: p.synths.length, images: p.media.filter((m: { kind: string }) => m.kind === "image").length,
      words: p.words.length,
    };
  });
  console.log(JSON.stringify(summary));
  expect(summary.anim2d).toBeGreaterThanOrEqual(4);   // AI 寫的 2D 至少 2 個＋內建 2D 範本
  expect(summary.anim3d).toBeGreaterThanOrEqual(2);   // AI 寫的 3D＋吉祥物等 3D 範本
  expect(summary.scene3d).toBeGreaterThanOrEqual(2);  // 3D 場景（桌上螢幕）＋翻頁片頭
  expect(summary.vibe2d).toBeGreaterThanOrEqual(2);   // Vibe 寫的 2D 插件
  expect(summary.vibe3d).toBeGreaterThanOrEqual(1);   // Vibe 寫的 3D 插件
  expect(summary.transitions).toBeGreaterThanOrEqual(3);
  expect(summary.kinds).toBeGreaterThanOrEqual(3);
  expect(summary.grades).toBeGreaterThanOrEqual(1);
  expect(summary.synths).toBeGreaterThanOrEqual(1);   // AI 配樂或音效
  expect(summary.images).toBeGreaterThanOrEqual(3);   // 片頭封面
  expect(summary.words).toBeGreaterThan(100);         // 逐字稿（逐字高亮字幕、3D 插件讀得到字）

  // 匯出整支，存到 output/sample-effects-export.mp4（人工檢查每種特效的樣子）
  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 1_400_000 });
  await expect(page.getByTestId("export-status")).not.toContainText("skipped");
  const b64 = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  mkdirSync(path.join(import.meta.dirname, "..", "output"), { recursive: true });
  writeFileSync(path.join(import.meta.dirname, "..", "output", "sample-effects-export.mp4"), Buffer.from(b64, "base64"));
  expect(blocked).toEqual([]);
});
