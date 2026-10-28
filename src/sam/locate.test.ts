import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { activeSample } from "./tracks";
import { linkBoxes, locatePrompt, runLocate, targetRoute, toRectMasks, type LocateFrame } from "./locate";

// 螢幕文字類個資的定位（開發者 2026-10-28：SAM 抓不到的帳號、密碼、金鑰、Email 等交給 Muse Spark）：
// 目標走哪條路、每秒 1 格的框串成物件（打字時框會變長，不能用 IoU 拆開）、遮罩每個取樣涵蓋到下一格的框（打字中不漏字）。

describe("targetRoute：實體物件走 SAM，文字類個資走 Spark", () => {
  it("分類", () => {
    for (const p of ["human face", "person", "license plate", "name badge", "credit card", "logo", "phone", "computer monitor", "coffee cup"]) expect(targetRoute(p), p).toBe("sam");
    for (const p of ["API key", "secret token", "password", "email address", "phone number", "account name", "username", "ID number", "credit card number", "home address"]) expect(targetRoute(p), p).toBe("spark");
  });

  it("常用目標的提示詞", () => {
    expect(locatePrompt("password")).toBe("password or passcode");
    expect(locatePrompt("API key")).toBe("API key or secret token");
    expect(locatePrompt("sticky note text")).toBe("sticky note text");
  });
});

/** 一格 */
const f = (t: number, items: [number, number, number, number, string?][]): LocateFrame => ({ t, items: items.map(([x, y, w, h, text]) => ({ x, y, w, h, text: text ?? "" })) });

describe("linkBoxes：同一列重疊或文字接得上就是同一個物件", () => {
  it("打字：框從短變長仍是同一個", () => {
    const tracks = linkBoxes([f(32, [[0.298, 0.076, 0.035, 0.022, "sk-proj-4"]]), f(33, [[0.298, 0.076, 0.12, 0.022, "sk-proj-4fX9qL2"]]), f(36, [[0.298, 0.076, 0.234, 0.022, "sk-proj-4fX9qL2mV7pZc8"]])]);
    expect(tracks).toHaveLength(1);
    expect(tracks[0].map((s) => s.t)).toEqual([32, 33, 36]);
  });

  it("捲動：同一串文字往上移仍是同一個；同一格兩個項目是兩個", () => {
    const tracks = linkBoxes([
      f(10, [[0.2, 0.5, 0.3, 0.02, "alice@example.com"], [0.2, 0.7, 0.3, 0.02, "bob@example.com"]]),
      f(11, [[0.2, 0.45, 0.3, 0.02, "alice@example.com"], [0.2, 0.65, 0.3, 0.02, "bob@example.com"]]),
    ]);
    expect(tracks).toHaveLength(2);
    expect(tracks.map((t) => t.length)).toEqual([2, 2]);
  });

  it("消失 2 秒又回來：同一個（中間不遮）", () => {
    const tracks = linkBoxes([f(1, [[0.1, 0.1, 0.2, 0.02, "pw"]]), f(2, []), f(3, []), f(4, [[0.1, 0.1, 0.2, 0.02, "pw"]])]);
    expect(tracks).toHaveLength(1);
    const [mask] = toRectMasks(tracks, { mediaId: "m", label: "password", idPrefix: "p" });
    expect(activeSample(mask, 2.5)).toBeNull();
    expect(activeSample(mask, 4.2)).not.toBeNull();
  });
});

describe("toRectMasks：每個取樣涵蓋到下一格的框，打字中不漏字", () => {
  it("32.5 秒的遮罩蓋得到 33 秒那格的長度", () => {
    const tracks = linkBoxes([f(32, [[0.298, 0.076, 0.035, 0.022]]), f(33, [[0.298, 0.076, 0.234, 0.022]])]);
    const [mask] = toRectMasks(tracks, { mediaId: "m", label: "API key", idPrefix: "k" });
    expect(mask).toMatchObject({ shape: "rect", label: "API key 1", interval: 1, mediaId: "m" });
    const s = activeSample(mask, 32.4)!;
    expect(s.box[2]).toBeCloseTo(0.298 + 0.234, 6);
  });
});

describe("runLocate：取樣（每秒 1 格）→ 每次最多 8 張送出 → 物件；用 2026-10-28 實測的回應", () => {
  const probe = JSON.parse(readFileSync(path.join(import.meta.dirname, "fixtures", "locate-probe.json"), "utf8")) as { frames: { t: number; items: LocateFrame["items"] }[] };

  it("三格實測回應 → 一個金鑰物件（打字中的短框和完整的框接成同一個）", async () => {
    const batches: number[][] = [];
    const result = await runLocate({
      mediaId: "m", target: "API key", start: 32, end: 40, label: "API key",
      grab: async (times) => times.map(() => new Uint8Array(4)),
      api: { locate: async (_target, frames) => { batches.push(frames.map((x) => x.t)); return frames.map((x) => ({ t: x.t, items: probe.frames.find((p) => p.t === x.t)?.items ?? [] })); } },
    });
    expect(batches).toEqual([[32, 33, 34, 35, 36, 37, 38, 39], [40]]);
    expect(result.objects).toHaveLength(1);
    expect(result.frames).toBe(9);
    // 實測只有 32、36、40 秒有東西：32 秒是打到一半的短框、33～35 秒（這份資料沒有）不遮、36 秒起是完整長度
    const obj = result.objects[0];
    expect(activeSample(obj, 32)!.box[2] - activeSample(obj, 32)!.box[0]).toBeCloseTo(0.035, 3);
    expect(activeSample(obj, 34.5)).toBeNull();
    expect(activeSample(obj, 36)!.box[2] - activeSample(obj, 36)!.box[0]).toBeGreaterThan(0.2);
  });
});
