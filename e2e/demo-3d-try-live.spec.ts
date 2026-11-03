import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// Demo 影片的 3D 鏡頭試做（2026-11-03，docs/demo-script.md）：不改程式，只用 Vibe 3D 一句話，
// 請 Muse Wonder 寫出「木紋桌上的螢幕（貼當格畫面）＋吉祥物在螢幕上走、按按鈕＋鏡頭跟著」的整個畫面，看品質夠不夠 demo 用。
// 連線上網頁版與閘道（會花 token），只在設了環境變數時跑：
//   $env:WORDBLADE_LIVE_SITE = 'https://wordblade.zeabur.app'; $env:WORDBLADE_LIVE_TOKEN = '<邀請權杖>'
//   $env:WORDBLADE_DEMO_VIDEO = 'output/demo-3d/source-10s.mp4'
//   pnpm playwright test e2e/demo-3d-try-live.spec.ts
// 可用 $env:WORDBLADE_DEMO_3D_PROMPT 換描述。結果：output/demo-3d/try.mp4、try-*.png、plugin.json（AI 寫的插件）。
const site = process.env.WORDBLADE_LIVE_SITE;
const token = process.env.WORDBLADE_LIVE_TOKEN;
const video = process.env.WORDBLADE_DEMO_VIDEO;
const GATEWAY = process.env.WORDBLADE_LIVE_GATEWAY ?? "https://wordblade-api.zeabur.app";
const OUT = path.join(import.meta.dirname, "..", "output", "demo-3d");
/** 時間軸每秒幾像素（預設） */
const PX = 20;
/** 給 Vibe 3D 的描述 */
const PROMPT = process.env.WORDBLADE_DEMO_3D_PROMPT ??
  "Full-frame 3D scene: a warm wooden desk with a large flat monitor lying on it that shows the current video frame. " +
  "A cute glossy dark cube robot mascot with a glowing teal face and short legs walks across the screen, stops at the center, and presses it with its hand (small bounce, ripple). " +
  "The camera looks down at about 50 degrees, slowly follows the mascot and dollies in a little. Soft studio lighting with shadows.";


/** 播放頭移到 t 秒 */
async function seek(page: Page, t: number) {
  await page.locator(".ruler").click({ position: { x: 1 + t * PX, y: 5 } });
}

test.describe("Vibe 3D 一句話", () => {
  test.skip(!site || !token || !video, "沒有設 WORDBLADE_LIVE_SITE／WORDBLADE_LIVE_TOKEN／WORDBLADE_DEMO_VIDEO");
  test.use({ baseURL: site });
test("Demo 3D 鏡頭試做：Vibe 3D 一句話 → 桌上螢幕＋吉祥物 → 匯出", async ({ page }) => {
  test.setTimeout(1_200_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(([url, tok]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    localStorage.setItem("wordblade.consent.vibe", "yes");
    localStorage.setItem("wordblade.exportToOpfs", "1");
    localStorage.setItem("wordblade.dev", "1");
  }, [GATEWAY, token!]);
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.resolve(video!));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 60_000 });
  await page.locator(".media-item").first().dblclick();
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);
  mkdirSync(OUT, { recursive: true });

  // 整段 0～9.5 秒放 Vibe 3D
  await seek(page, 0);
  const row = (await page.locator('.track-row[data-track-id="V1"]').boundingBox())!;
  await page.keyboard.down("Shift");
  await page.mouse.move(row.x + 1, row.y + row.height / 2);
  await page.mouse.down();
  await page.mouse.move(row.x + 1 + 9.5 * PX, row.y + row.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await openTab(page, "vibe3d");
  await page.getByTestId("vibe-description").fill(PROMPT);
  const t0 = Date.now();
  await page.getByTestId("vibe-generate").click();
  await expect(page.locator(".effect-chip").or(page.getByTestId("vibe-error"))).toHaveCount(1, { timeout: 480_000 });
  await expect(page.getByTestId("vibe-error")).toHaveCount(0);
  console.log(`Vibe 3D：${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

  // 存下 AI 寫的插件（之後要修程式時對照）
  const plugin = await page.evaluate(() => {
    const p = (window as unknown as { __wordblade: { project: () => { plugins: { source?: string }[] } } }).__wordblade.project();
    return p.plugins.filter((x) => x.source === "vibe");
  });
  writeFileSync(path.join(OUT, "plugin.json"), JSON.stringify(plugin, null, 1));
  for (const t of [1, 4, 7]) {
    await seek(page, t);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, `try-${t}s.png`) });
  }

  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 600_000 });
  const b64 = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  writeFileSync(path.join(OUT, "try.mp4"), Buffer.from(b64, "base64"));
});
});

// 組合版（不呼叫 AI）：內建「桌上螢幕・固定鏡頭」（木紋桌，desk-still）＋內建吉祥物疊在上面走到目標框。
// 本機就能跑：$env:WORDBLADE_DEMO_VIDEO = 'output/demo-3d/source-10s.mp4'; pnpm playwright test e2e/demo-3d-try-live.spec.ts -g 組合版
test.describe("組合版", () => {
  test.skip(!video, "沒有設 WORDBLADE_DEMO_VIDEO");
test("Demo 3D 鏡頭試做（組合版）：桌上螢幕＋固定鏡頭＋吉祥物 → 匯出", async ({ page }) => {
  test.setTimeout(1_200_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(() => localStorage.setItem("wordblade.exportToOpfs", "1"));
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.resolve(video!));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 60_000 });
  await page.locator(".media-item").first().dblclick();
  await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);
  mkdirSync(OUT, { recursive: true });

  /** Shift＋拖曳選範圍 */
  const range = async (a: number, b: number) => {
    await seek(page, a);
    const row = (await page.locator('.track-row[data-track-id="V1"]').boundingBox())!;
    await page.keyboard.down("Shift");
    await page.mouse.move(row.x + 1 + a * PX, row.y + row.height / 2);
    await page.mouse.down();
    await page.mouse.move(row.x + 1 + b * PX, row.y + row.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up("Shift");
  };
  await range(0, 9.5);
  await openTab(page, "vibe3d");
  await page.locator('[data-template="desk-still"]').click();
  await expect(page.locator(".effect-chip")).toHaveCount(1);

  await range(2, 8);
  await openTab(page, "vibe3d");
  await page.locator('[data-template="mascot-point"]').click();
  await expect(page.locator(".effect-chip")).toHaveCount(2);
  for (const t of [1, 5]) {
    await seek(page, t);
    await page.waitForTimeout(1500);
    await page.screenshot({ path: path.join(OUT, `combo-${t}s.png`) });
  }

  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 600_000 });
  const b64 = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  writeFileSync(path.join(OUT, "combo.mp4"), Buffer.from(b64, "base64"));
});
});

// 互動版（2026-11-03）：固定鏡頭桌上螢幕＋3D 機器人走進來指著 → Vibe 2D 生成「2D 版的自己」從框裡跳出來 → 3D 機器人揮手回應。
// 吉祥物與 2D 都在螢幕右下角，不擋內容。Vibe 2D 要呼叫 AI（本機 dev server＋線上閘道，CORS 放行 localhost:1420）：
//   $env:WORDBLADE_DEMO_VIDEO = 'output/demo-3d/source-10s.mp4'; $env:WORDBLADE_LIVE_TOKEN = '<權杖>'
//   pnpm playwright test e2e/demo-3d-try-live.spec.ts -g 互動版
test.describe("互動版", () => {
  test.skip(!video || !token, "沒有設 WORDBLADE_DEMO_VIDEO／WORDBLADE_LIVE_TOKEN");
  test("Demo 3D 鏡頭試做（互動版）：3D 機器人＋Vibe 2D 的自己 → 匯出", async ({ page }) => {
    test.setTimeout(1_200_000);
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.addInitScript(([url, tok]) => {
      localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
      localStorage.setItem("wordblade.consent.vibe", "yes");
      localStorage.setItem("wordblade.exportToOpfs", "1");
      localStorage.setItem("wordblade.dev", "1");
    }, [GATEWAY, token!]);
    await page.goto("/");
    const chooser = page.waitForEvent("filechooser");
    await page.getByTestId("import-media").click();
    await (await chooser).setFiles(path.resolve(video!));
    await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 60_000 });
    await page.locator(".media-item").first().dblclick();
    await expect(page.locator('.track-row[data-track-id="V1"] .clip')).toHaveCount(1);
    mkdirSync(OUT, { recursive: true });

    /** Shift＋拖曳選範圍 */
    const range = async (a: number, b: number) => {
      await seek(page, a);
      const row = (await page.locator('.track-row[data-track-id="V1"]').boundingBox())!;
      await page.keyboard.down("Shift");
      await page.mouse.move(row.x + 1 + a * PX, row.y + row.height / 2);
      await page.mouse.down();
      await page.mouse.move(row.x + 1 + b * PX, row.y + row.height / 2, { steps: 5 });
      await page.mouse.up();
      await page.keyboard.up("Shift");
    };
    type Hook = { project: () => { effects: { id: string; params: Record<string, unknown> }[] }; dispatch: (a: unknown) => void };
    /** 最後加的特效改目標框（畫面座標 0～1） */
    const setBox = (box: { cx: number; cy: number; w: number; h: number }) => page.evaluate((b) => {
      const hook = (window as unknown as { __wordblade: Hook }).__wordblade;
      const e = hook.project().effects.at(-1)!;
      hook.dispatch({ type: "commit", edits: [{ kind: "setEffectParams", effectId: e.id, params: { ...e.params, box: b } }] });
    }, box);
    /** 2D 的自己出現的框（螢幕右下、內容外側） */
    const BOX2D = { cx: 0.66, cy: 0.74, w: 0.16, h: 0.26 };

    await range(0, 9.5);
    await openTab(page, "vibe3d");
    await page.locator('[data-template="desk-still"]').click();
    await expect(page.locator(".effect-chip")).toHaveCount(1);

    // 1.5～9.5 秒：3D 機器人從右邊走進來，先指著 2D 會出現的地方，後半段揮手跟它打招呼
    await range(1.5, 9.5);
    await page.locator('[data-template="robot-wave"]').click();
    await expect(page.locator(".effect-chip")).toHaveCount(2);
    await setBox(BOX2D);

    // 3.5～9.5 秒：Vibe 2D 生成 2D 版的自己
    await range(3.5, 9.5);
    await openTab(page, "vibe");
    await page.getByTestId("vibe-description").fill(process.env.WORDBLADE_DEMO_2D_PROMPT ??
      "A flat 2D cartoon version of a cute dark cube robot with a glowing teal face, teal round ears and a teal antenna ball: it pops out of a small teal sparkle burst, bounces once, then waves happily. Clean vector style with a soft shadow. Stay inside the box.");
    await page.getByTestId("vibe-generate").click();
    await expect(page.locator(".effect-chip").or(page.getByTestId("vibe-error"))).toHaveCount(3, { timeout: 480_000 });
    await expect(page.getByTestId("vibe-error")).toHaveCount(0);
    await setBox(BOX2D);

    await openTab(page, "export");
    await page.getByTestId("export-start").click();
    await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 600_000 });
    const b64 = await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
      const bytes = new Uint8Array(await (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    writeFileSync(path.join(OUT, "interact.mp4"), Buffer.from(b64, "base64"));
  });
});
