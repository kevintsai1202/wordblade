import { expect, test } from "@playwright/test";

// Vibe特效實機測試：連真的閘道與 Muse Wonder（會花 token），只在設了環境變數時跑：
//   $env:WORDBLADE_LIVE_GATEWAY = 'http://localhost:8080'; $env:WORDBLADE_LIVE_TOKEN = '<邀請權杖>'
//   pnpm playwright test e2e/vibe-live.spec.ts
// 閘道的 CORS 要放行 http://localhost:4173（e2e 的 preview 伺服器）。權杖只從環境變數讀，不寫進檔案。
const gateway = process.env.WORDBLADE_LIVE_GATEWAY;
const token = process.env.WORDBLADE_LIVE_TOKEN;

test.skip(!gateway || !token, "沒有設 WORDBLADE_LIVE_GATEWAY／WORDBLADE_LIVE_TOKEN");

test("Vibe 實機：一句話 → Wonder 寫插件 → 沙盒試跑 → 加到時間軸並畫出來", async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(([url, tok]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    localStorage.setItem("wordblade.consent.vibe", "yes");
  }, [gateway!, token!]);
  await page.goto("/");
  await page.locator('[data-tab="vibe"]').click();
  await page.getByTestId("vibe-description").fill("Bright orange confetti bursting upward from the bottom of the box");
  const t0 = Date.now();
  await page.getByTestId("vibe-generate").click();
  await expect(page.locator('.effect-chip, [data-testid="vibe-error"]')).toHaveCount(1, { timeout: 170_000 });
  await expect(page.getByTestId("vibe-error")).toHaveCount(0);
  console.log(`Vibe 實機：${((Date.now() - t0) / 1000).toFixed(1)} 秒`);

  // 播放頭移到特效中間：畫面上有東西（非黑）
  await page.locator(".ruler").click({ position: { x: 25, y: 5 } });
  await expect.poll(() => page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const p = document.createElement("canvas");
    p.width = 160;
    p.height = 90;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 160, 90);
    const d = ctx.getImageData(0, 0, 160, 90).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) lit++;
    return lit;
  }), { timeout: 15_000 }).toBeGreaterThan(20);
  await page.screenshot({ path: "output/ui-shots/vibe-live.png" });
});

test("Vibe 3D 實機：一句話 → Wonder 寫 three.js 插件 → 3D 沙盒試跑 → 疊在畫面上", async ({ page }) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(([url, tok]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    localStorage.setItem("wordblade.consent.vibe", "yes");
  }, [gateway!, token!]);
  await page.goto("/");
  await page.locator('[data-tab="vibe"]').click();
  await page.getByTestId("vibe-description").fill("A shiny golden 3D star that spins and bounces above the box, with a few small sparkles around it");
  await page.getByTestId("vibe-3d").check();
  const t0 = Date.now();
  await page.getByTestId("vibe-generate").click();
  await expect(page.locator('.effect-chip, [data-testid="vibe-error"]')).toHaveCount(1, { timeout: 230_000 });
  await expect(page.getByTestId("vibe-error")).toHaveCount(0);
  console.log(`Vibe 3D 實機：${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  await page.locator(".ruler").click({ position: { x: 40, y: 5 } });
  await expect.poll(() => page.getByTestId("preview-canvas").evaluate((c: HTMLCanvasElement) => {
    const p = document.createElement("canvas");
    p.width = 160;
    p.height = 90;
    const ctx = p.getContext("2d")!;
    ctx.drawImage(c, 0, 0, 160, 90);
    const d = ctx.getImageData(0, 0, 160, 90).data;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 120) lit++;
    return lit;
  }), { timeout: 30_000 }).toBeGreaterThan(20);
  await page.screenshot({ path: "output/ui-shots/vibe3d-live.png" });
});
