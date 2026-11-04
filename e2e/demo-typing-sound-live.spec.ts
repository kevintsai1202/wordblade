import { expect, test } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// Demo 影片的打字聲試聽（2026-11-04）：用 WordBlade 的 AI 音效照幾種描述各生成一段，存成 WAV 給人挑，
// 挑中的描述再放進 e2e/demo-cut-live.spec.ts。連線上閘道，本機 dev server：
//   $env:WORDBLADE_LIVE_TOKEN = '<權杖>'; $env:WORDBLADE_E2E_PORT = '1420'
//   pnpm playwright test e2e/demo-typing-sound-live.spec.ts
// 產出：output/demo-cut/typing/typing-1.wav …
const token = process.env.WORDBLADE_LIVE_TOKEN;
const GATEWAY = process.env.WORDBLADE_LIVE_GATEWAY ?? "https://wordblade-api.zeabur.app";
const OUT = path.join(import.meta.dirname, "..", "output", "demo-cut", "typing");

/** 幾種打字聲描述（越具體越像：很短的高頻雜訊、間隔不規律、沒有音調） */
export const TYPING_PROMPTS = [
  "Realistic laptop keyboard typing: about 9 separate key clicks over 1.2 seconds at irregular intervals (70 to 200 ms apart). Each click is a very short burst of white noise (8 to 15 ms), high-pass filtered around 2.5 kHz, sharp attack, fast decay, slightly different loudness. No tone, no music.",
  "Mechanical keyboard typing close to the mic: 10 crisp key presses in 1.3 seconds, uneven rhythm. Each press = a 6 ms click of bright noise (band-pass 3 to 6 kHz) plus a soft low thock (noise low-passed at 400 Hz, 30 ms). Dry, no reverb, no pitch.",
  "Quiet office typing: 8 soft plastic key taps over 1 second, irregular timing, each tap a 12 ms filtered noise tick (band-pass 1.5 to 4 kHz) with very fast decay, small random volume changes. No musical notes.",
];

test.skip(!token, "沒有設 WORDBLADE_LIVE_TOKEN");

test("打字聲試聽：AI 音效照幾種描述各生成一段", async ({ page }) => {
  test.setTimeout(900_000);
  await page.addInitScript(([url, tok]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    localStorage.setItem("wordblade.consent.audio", "yes");
    localStorage.setItem("wordblade.dev", "1");
  }, [GATEWAY, token!]);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await openTab(page, "audio");
  mkdirSync(OUT, { recursive: true });
  for (const [i, prompt] of TYPING_PROMPTS.entries()) {
    await page.getByTestId("sound-description").fill(prompt);
    await page.getByTestId("sound-length").fill("1.3");
    await page.getByTestId("sound-generate").click();
    await expect(page.getByTestId("sound-result").or(page.getByTestId("sound-error"))).toBeVisible({ timeout: 180_000 });
    await expect(page.getByTestId("sound-error")).toHaveCount(0);
    await page.getByTestId("sound-save").click();
    await expect(page.getByTestId("sound-save")).toHaveText("In media", { timeout: 30_000 });
    // 剛存進素材庫的那一個（最後一個）拿出位元組
    const bytes = await page.evaluate(async () => {
      type M = { name?: string; path?: string; handleKey?: string };
      const hook = (window as unknown as { __wordblade: { project: () => { media: M[] }; fileBytes: (k: string) => Promise<Uint8Array | null> } }).__wordblade;
      const m = hook.project().media.at(-1)!;
      let b: Uint8Array | null = m.handleKey ? await hook.fileBytes(m.handleKey) : null;
      if (!b && m.path) b = new Uint8Array(await (await fetch(m.path)).arrayBuffer());
      return b ? Array.from(b) : null;
    });
    expect(bytes?.length ?? 0).toBeGreaterThan(1000);
    writeFileSync(path.join(OUT, `typing-${i + 1}.wav`), Buffer.from(bytes!));
    console.log(`已存 typing-${i + 1}.wav`);
  }
});
