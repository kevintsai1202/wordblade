import { expect, type Page } from "@playwright/test";
import path from "node:path";
import { openTab } from "./tabs";

// e2e 共用：用假閘道（page.route 攔 /v1/asr）轉錄 talk.mp4，得到有字幕的專案。不連真的閘道、不花錢。
const FIXTURES = path.join(import.meta.dirname, "..", "fixtures");
const GATEWAY = "https://fake-gateway.test";

/** 一段假的轉錄結果 */
export type FakeTurn = { transcript: string; startMs: number; endMs: number };

/** 預設的轉錄結果："Hello world." 0～2 秒、"Again." 2.5～4 秒 */
const DEFAULT_TURNS: FakeTurn[] = [
  { transcript: "Hello world.", startMs: 0, endMs: 2000 },
  { transcript: "Again.", startMs: 2500, endMs: 4000 },
];

/** 匯入 talk.mp4、放上 V1、用假閘道轉錄（turns 可換） */
export async function transcribed(page: Page, turns: FakeTurn[] = DEFAULT_TURNS) {
  await page.addInitScript((url) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: "t" }));
    localStorage.setItem("wordblade.consent.asr", "yes");
    localStorage.setItem("wordblade.exportToOpfs", "1");
  }, GATEWAY);
  await page.route(`${GATEWAY}/v1/asr`, (route) => route.fulfill({
    status: 200, contentType: "application/json", headers: { "access-control-allow-origin": "*" },
    body: JSON.stringify({ transcript: turns.map((t) => t.transcript).join(" "), audioDurationMs: 4000, turns: turns.map((t) => ({ ...t, speaker: "A" })) }),
  }));
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  const chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(path.join(FIXTURES, "talk.mp4"));
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 20_000 });
  await page.locator(".media-item", { hasText: "talk.mp4" }).dblclick();
  await openTab(page, "transcript");
  await expect(page.getByTestId("transcribe-start")).toBeEnabled({ timeout: 20_000 });
  await page.getByTestId("transcribe-start").click();
  await expect(page.getByTestId("transcribe-status")).toContainText("words", { timeout: 20_000 });
}

