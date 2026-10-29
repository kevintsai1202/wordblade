import { describe, expect, it } from "vitest";
import { findActivities, zoomFromActivity, type LumaFrame } from "./activity";

// 畫面變化偵測（docs/plan-10-29-director2.md §4）：比對前後兩格，找出「正在打字、印出結果」這種局部變化的區域與時間；
// 整片在變（捲動、換畫面）不算。放大的路徑跟著變化區的中心走。
const W = 320;
const H = 180;

/** 一格：底色 40，rects 裡的區域填 value */
function frame(t: number, rects: { x: number; y: number; w: number; h: number; value: number }[]): LumaFrame {
  const luma = new Uint8Array(W * H).fill(40);
  for (const r of rects) for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) luma[y * W + x] = r.value;
  return { t, width: W, height: H, luma };
}

/** 打字：t 秒時從 (x0, y) 往右多出一個字（寬 6）；前面打過的字留著 */
function typing(t: number, from: number, x0: number, y: number) {
  const n = Math.max(0, t - from + 1);
  return Array.from({ length: n }, (_, i) => ({ x: x0 + i * 8, y, w: 6, h: 10, value: 220 }));
}

describe("findActivities", () => {
  it("一行字慢慢打出來 → 一個活動區：時間對、外框框住那一行；靜止的畫面沒有活動", () => {
    const frames = Array.from({ length: 12 }, (_, t) => frame(t, t >= 3 && t <= 8 ? typing(t, 3, 100, 60) : t > 8 ? typing(8, 3, 100, 60) : []));
    const acts = findActivities(frames);
    expect(acts).toHaveLength(1);
    const a = acts[0];
    expect(a.start).toBeGreaterThanOrEqual(2);
    expect(a.start).toBeLessThanOrEqual(3);
    expect(a.end).toBeGreaterThanOrEqual(8);
    expect(a.end).toBeLessThanOrEqual(9);
    // 外框（0～1）包住 x 100～146、y 60～70
    expect(a.x).toBeLessThanOrEqual(100 / W + 0.02);
    expect(a.x + a.w).toBeGreaterThanOrEqual(146 / W - 0.02);
    expect(a.y).toBeLessThanOrEqual(60 / H + 0.02);
    expect(a.y + a.h).toBeGreaterThanOrEqual(70 / H - 0.02);
    // 路徑跟著打字往右走
    expect(a.path[a.path.length - 1].cx).toBeGreaterThan(a.path[0].cx);
    expect(a.id).toMatch(/^a\d+/);
  });

  it("整片在變（捲動、換畫面）不算活動；兩處分開的變化各自成一個", () => {
    const frames = [
      frame(0, []),
      frame(1, [{ x: 0, y: 0, w: W, h: H, value: 200 }]),
      frame(2, [{ x: 0, y: 0, w: W, h: H, value: 90 }]),
      frame(3, [{ x: 0, y: 0, w: W, h: H, value: 90 }]),
    ];
    expect(findActivities(frames)).toEqual([]);
    const two = [
      ...Array.from({ length: 5 }, (_, t) => frame(t, typing(t, 0, 20, 20))),
      ...Array.from({ length: 5 }, (_, i) => frame(20 + i, [...typing(4, 0, 20, 20), ...typing(i, 0, 200, 150)])),
    ];
    const acts = findActivities(two);
    expect(acts).toHaveLength(2);
    expect(acts[0].y).toBeLessThan(0.2);
    expect(acts[1].y).toBeGreaterThan(0.75);
  });
});

describe("zoomFromActivity", () => {
  it("一行一行往下打字（聯集很大、每次變化很小）：框寬看每次變化的大小，不會變成幾乎沒放大", () => {
    const path = Array.from({ length: 10 }, (_, i) => ({ t: 40 + i, cx: 0.4, cy: 0.1 + i * 0.08, w: 0.3, h: 0.06 }));
    const z = zoomFromActivity({ id: "a400", start: 40, end: 50, x: 0.25, y: 0.07, w: 0.3, h: 0.8, path });
    expect(z.w).toBeLessThan(0.65);
    expect(z.path[z.path.length - 1].cy).toBeGreaterThan(z.path[1].cy);
  });

  it("框寬包得住活動區（留邊、0.3～0.8），路徑點用素材時間、框不超出畫面", () => {
    const act = { id: "a3", start: 3, end: 9, x: 0.31, y: 0.33, w: 0.15, h: 0.06, path: [{ t: 3, cx: 0.33, cy: 0.36, w: 0.05, h: 0.06 }, { t: 6, cx: 0.38, cy: 0.36, w: 0.05, h: 0.06 }, { t: 9, cx: 0.97, cy: 0.98, w: 0.05, h: 0.06 }] };
    const z = zoomFromActivity(act);
    expect(z.w).toBeGreaterThanOrEqual(0.3);
    expect(z.w).toBeLessThanOrEqual(0.8);
    expect(z.path[0].src).toBe(3);
    for (const p of z.path) {
      expect(p.cx - z.w / 2).toBeGreaterThanOrEqual(-1e-9);
      expect(p.cx + z.w / 2).toBeLessThanOrEqual(1 + 1e-9);
      expect(p.cy + z.w / 2).toBeLessThanOrEqual(1 + 1e-9);
    }
  });
});
