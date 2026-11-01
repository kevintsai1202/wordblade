import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

// 網頁版專案資料夾（spec §5.21、D41，2026-11-01）：File System Access 選資料夾、handle 記在 IndexedDB。
// Playwright 接不到 showDirectoryPicker／showOpenFilePicker，這裡把它們換成 OPFS 裡的資料夾與檔案：
// OPFS 的 handle 就是真的 FileSystemDirectoryHandle／FileSystemFileHandle，之後的寫檔、IndexedDB、重新整理後重開都照實跑。
const FIXTURES = path.join(import.meta.dirname, "fixtures");

/** 選取器換成 OPFS：選資料夾回 window.__pickDir 指定的 OPFS 子資料夾；選檔回 OPFS media/ 裡 window.__pickFiles 列的檔案 */
async function stubPickers(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    w.__pickDir = "parent";
    w.__pickFiles = [];
    /** OPFS 裡的路徑（a/b/c）→ 資料夾 handle */
    const dirAt = async (p: string) => {
      let d = await navigator.storage.getDirectory();
      for (const seg of p.split("/").filter(Boolean)) d = await d.getDirectoryHandle(seg, { create: true });
      return d;
    };
    w.showDirectoryPicker = async () => dirAt(w.__pickDir as string);
    w.showOpenFilePicker = async () => {
      const media = await dirAt("media");
      return Promise.all((w.__pickFiles as string[]).map((n) => media.getFileHandle(n)));
    };
  });
}

/** 把 fixture 檔寫進 OPFS 的 media/ */
async function putFixture(page: Page, name: string) {
  const b64 = readFileSync(path.join(FIXTURES, name)).toString("base64");
  await page.evaluate(async ([n, data]) => {
    const media = await (await navigator.storage.getDirectory()).getDirectoryHandle("media", { create: true });
    const w = await (await media.getFileHandle(n, { create: true })).createWritable();
    await w.write(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));
    await w.close();
  }, [name, b64] as const);
}

/** 讀 OPFS 裡的文字檔；沒有回 null */
function readOpfs(page: Page, p: string): Promise<string | null> {
  return page.evaluate(async (file) => {
    try {
      let d = await navigator.storage.getDirectory();
      const segs = file.split("/");
      for (const seg of segs.slice(0, -1)) d = await d.getDirectoryHandle(seg);
      return await (await (await d.getFileHandle(segs.at(-1)!)).getFile()).text();
    } catch {
      return null;
    }
  }, p);
}

test("網頁版專案資料夾：存成 .wordblade、重新整理後從最近開啟重開，記住的素材找得回來，沒記住的可以重新連結", async ({ page }) => {
  test.setTimeout(120_000);
  await stubPickers(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await putFixture(page, "talk.mp4");
  await putFixture(page, "gaps.mp4");

  // 還沒開專案：用 <input> 匯入 talk.mp4（拿不到 handle）
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });

  // 另存：在 OPFS parent/ 底下建 Demo.wordblade（含 .data）
  await page.getByTestId("project-save-as").click();
  await page.getByTestId("project-name-input").fill("Demo");
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await expect(page.getByTestId("project-name")).toHaveText("Demo");
  await expect.poll(() => readOpfs(page, "parent/Demo.wordblade/project.json"), { timeout: 10_000 }).toContain("talk.mp4");
  expect(await page.evaluate(async () => {
    const d = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("parent")).getDirectoryHandle("Demo.wordblade");
    return !!(await d.getDirectoryHandle(".data"));
  })).toBe(true);

  // 開著專案：選檔改走 showOpenFilePicker（拿得到 handle）→ 匯入 gaps.mp4，自動存檔寫進 project.json
  await page.evaluate(() => { (window as unknown as { __pickFiles: string[] }).__pickFiles = ["gaps.mp4"]; });
  await page.getByTestId("import-media").click();
  await expect(page.locator(".media-item", { hasText: "gaps.mp4" })).toBeVisible({ timeout: 20_000 });
  await page.locator(".media-item", { hasText: "gaps.mp4" }).dblclick();
  await expect.poll(() => readOpfs(page, "parent/Demo.wordblade/project.json"), { timeout: 10_000 }).toContain("gaps.mp4");
  // 開著專案匯入：複製進 .data/media/（桌面版開這個專案也找得到）
  expect(await page.evaluate(async () => {
    const d = await (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle("parent")).getDirectoryHandle("Demo.wordblade")).getDirectoryHandle(".data")).getDirectoryHandle("media");
    return (await (await d.getFileHandle("gaps.mp4")).getFile()).size;
  })).toBeGreaterThan(1000);
  await expect.poll(async () => JSON.parse((await readOpfs(page, "parent/Demo.wordblade/project.json")) ?? "{}").project?.clips?.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);

  // prepare 的結果（縮圖＋音量包絡）存進 OPFS thumbs/<鍵>/
  const cachedBefore = await page.evaluate(async () => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("thumbs");
    const out: Record<string, number> = {};
    for await (const [name, h] of (root as unknown as AsyncIterable<[string, FileSystemDirectoryHandle]>)) {
      try { out[name] = (await (await h.getFileHandle("prepared.json")).getFile()).lastModified; } catch { /* 沒有 */ }
    }
    return out;
  });
  expect(Object.keys(cachedBefore).length).toBeGreaterThanOrEqual(1);

  // 重新整理：從最近開啟重開
  await page.reload();
  await page.getByTestId("project-recent").selectOption({ label: "Demo" });
  await expect(page.getByTestId("project-name")).toHaveText("Demo");
  // 重開用快取：素材很快就緒，快取檔沒有被重寫
  await expect(page.locator(".media-item", { hasText: "gaps.mp4" }).locator("img")).toBeVisible({ timeout: 5_000 });
  const cachedAfter = await page.evaluate(async (names) => {
    const root = await (await navigator.storage.getDirectory()).getDirectoryHandle("thumbs");
    const out: Record<string, number> = {};
    for (const n of names) out[n] = (await (await (await root.getDirectoryHandle(n)).getFileHandle("prepared.json")).getFile()).lastModified;
    return out;
  }, Object.keys(cachedBefore));
  expect(cachedAfter).toEqual(cachedBefore);
  // gaps.mp4 記住了 handle → 找得回來；talk.mp4 是 <input> 匯入的 → 列為找不到
  await expect(page.getByTestId("missing-media")).toContainText("talk.mp4");
  await expect(page.getByTestId("missing-media")).not.toContainText("gaps.mp4");

  // 重新連結 talk.mp4（選檔走 showOpenFilePicker）
  await page.evaluate(() => { (window as unknown as { __pickFiles: string[] }).__pickFiles = ["talk.mp4"]; });
  await page.getByTestId("relink-media").click();
  await expect(page.getByTestId("missing-media")).toHaveCount(0);
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
});

test("網頁版開桌面版存的專案：素材只有絕對路徑，放在專案資料夾裡的用檔名＋指紋找回來", async ({ page }) => {
  test.setTimeout(120_000);
  await stubPickers(page);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await putFixture(page, "talk.mp4");
  // 先在網頁版做一個有 talk.mp4 片段的專案，拿它的 project.json 改成桌面版的樣子（素材沒有 handleKey、只有 Windows 路徑）
  await page.evaluate(() => { (window as unknown as { __pickDir: string }).__pickDir = "parent"; });
  await page.getByTestId("project-save-as").click();
  await page.getByTestId("project-name-input").fill("Web");
  await page.getByRole("button", { name: "Choose folder…" }).click();
  await expect(page.getByTestId("project-name")).toHaveText("Web");
  await page.evaluate(() => { (window as unknown as { __pickFiles: string[] }).__pickFiles = ["talk.mp4"]; });
  await page.getByTestId("import-media").click();
  await expect(page.locator(".media-item", { hasText: "talk.mp4" })).toBeVisible({ timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  await expect.poll(async () => JSON.parse((await readOpfs(page, "parent/Web.wordblade/project.json")) ?? "{}").project?.clips?.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(0);
  // 網頁版存的參照有檔名與指紋（桌面版開的時候用）
  const saved = JSON.parse((await readOpfs(page, "parent/Web.wordblade/project.json"))!);
  const ref = Object.values(saved.media)[0] as { name?: string; fingerprint?: string };
  expect(ref.name).toBe("talk.mp4");
  expect(ref.fingerprint).toMatch(/^\d+:[0-9a-f]{16}$/);

  // 做成「桌面版存的專案」：Desk.wordblade/project.json＋專案資料夾裡的 talk.mp4
  await page.evaluate(async (text) => {
    const data = JSON.parse(text);
    for (const m of data.project.media) { delete m.handleKey; m.path = "D:\\elsewhere\\" + m.name; }
    for (const id of Object.keys(data.media)) data.media[id] = { path: "D:\\elsewhere\\talk.mp4", rel: "../talk.mp4", fingerprint: data.media[id].fingerprint };
    const root = await navigator.storage.getDirectory();
    const desk = await (await root.getDirectoryHandle("parent")).getDirectoryHandle("Desk.wordblade", { create: true });
    const write = async (name: string, body: Blob | string) => { const w = await (await desk.getFileHandle(name, { create: true })).createWritable(); await w.write(body); await w.close(); };
    await write("project.json", JSON.stringify(data));
    await write("talk.mp4", await (await (await root.getDirectoryHandle("media")).getFileHandle("talk.mp4")).getFile());
  }, JSON.stringify(saved));

  // 重新整理後用 Open… 開它：素材找得回來（沒有「找不到」提示），預覽準備好
  await page.reload();
  await page.evaluate(() => { (window as unknown as { __pickDir: string }).__pickDir = "parent/Desk.wordblade"; });
  await page.getByTestId("project-open").click();
  await expect(page.getByTestId("project-name")).toHaveText("Desk");
  await expect(page.locator(".media-item", { hasText: "talk.mp4" }).locator("img")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("missing-media")).toHaveCount(0);
});
