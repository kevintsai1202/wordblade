import { describe, expect, it } from "vitest";
import { makeClip, makeProject } from "./fixtures";
import { applyEdits } from "./history";
import { framePlan } from "../compositor/framePlan";
import { splitClip } from "./timeline";
import { insertZoomKey, ZOOM_RAMP, zoomAt, zoomCrop } from "./zoom";

/** 一個有兩個關鍵幀（3 秒與 5 秒、放大 2 倍、中心 0.6, 0.4）的片段 */
const clip = makeClip({ id: "c", mediaId: "m1", trackId: "V1", srcIn: 0, srcOut: 10, start: 0, zoomKeys: [
  { src: 3, scale: 2, cx: 0.6, cy: 0.4 },
  { src: 5, scale: 2, cx: 0.6, cy: 0.4 },
] });

describe("zoomAt（局部放大的每格倍率與中心）", () => {
  it("第一個關鍵幀前 0.5 秒以外、最後一個之後 0.5 秒以外是原畫面", () => {
    expect(zoomAt(clip, 2).scale).toBe(1);
    expect(zoomAt(clip, 6).scale).toBe(1);
  });

  it("兩個關鍵幀之間停留；推進一半時的倍率在 1 與 2 之間（對數內插：√2）", () => {
    expect(zoomAt(clip, 4)).toMatchObject({ scale: 2, cx: 0.6, cy: 0.4 });
    const mid = zoomAt(clip, 3 - ZOOM_RAMP / 2);
    expect(mid.scale).toBeGreaterThan(1);
    expect(mid.scale).toBeLessThan(2);
    // 緩動是 smoothstep，正中間剛好一半：對數內插的一半＝√2
    expect(mid.scale).toBeCloseTo(Math.SQRT2, 3);
    // 推進時中心直接對著目標
    expect(mid.cx).toBeCloseTo(0.6);
  });

  it("關鍵幀之間沿路徑移動；倍率 1 的關鍵幀結束這一段", () => {
    const c = makeClip({ id: "d", mediaId: "m1", trackId: "V1", srcIn: 0, srcOut: 10, start: 0, zoomKeys: [
      { src: 1, scale: 2, cx: 0.2, cy: 0.5 },
      { src: 3, scale: 2, cx: 0.8, cy: 0.5 },
      { src: 4, scale: 1, cx: 0.5, cy: 0.5 },
    ] });
    const z = zoomAt(c, 2);
    expect(z.cx).toBeGreaterThan(0.2);
    expect(z.cx).toBeLessThan(0.8);
    expect(zoomAt(c, 4.2).scale).toBe(1);
  });

  it("沒有關鍵幀是原畫面；倍率夾在 1～4", () => {
    expect(zoomAt(makeClip({ id: "e", mediaId: "m1", trackId: "V1", srcIn: 0, srcOut: 10, start: 0 }), 3).scale).toBe(1);
    const big = makeClip({ id: "f", mediaId: "m1", trackId: "V1", srcIn: 0, srcOut: 10, start: 0, zoomKeys: [{ src: 2, scale: 9, cx: 0.5, cy: 0.5 }, { src: 4, scale: 9, cx: 0.5, cy: 0.5 }] });
    expect(zoomAt(big, 3).scale).toBe(4);
  });
});

describe("zoomCrop（要取的畫面範圍）", () => {
  it("寬高都是 1/倍率（比例跟畫面一樣），以中心為準，超出畫面就夾回來", () => {
    expect(zoomCrop({ scale: 2, cx: 0.5, cy: 0.5 })).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(zoomCrop({ scale: 2, cx: 0.1, cy: 0.95 })).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(zoomCrop({ scale: 1, cx: 0.9, cy: 0.9 })).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });
});

describe("framePlan 與編輯", () => {
  it("有放大的片段，影像圖層帶裁切範圍；沒放大的不帶", () => {
    const p = makeProject();
    p.clips = p.clips.map((c) => (c.id === "v1a" ? { ...c, zoomKeys: clip.zoomKeys } : c));
    const layer = framePlan(p, 4).find((l) => l.clipId === "v1a")!;
    expect(layer.crop).toEqual({ x: 0.35, y: 0.15, w: 0.5, h: 0.5 });
    expect(framePlan(p, 1).find((l) => l.clipId === "v1a")!.crop).toBeUndefined();
    expect(framePlan(p, 21).find((l) => l.clipId === "v1c")!.crop).toBeUndefined();
  });

  it("setZoomKeys 依素材時間排序、可以復原；片段切開後兩段都帶著關鍵幀", () => {
    const p = makeProject();
    const next = applyEdits(p, [{ kind: "setZoomKeys", clipId: "v1a", keys: [{ src: 5, scale: 2, cx: 0.5, cy: 0.5 }, { src: 3, scale: 2, cx: 0.5, cy: 0.5 }] }]);
    expect(next.clips.find((c) => c.id === "v1a")!.zoomKeys!.map((k) => k.src)).toEqual([3, 5]);
    expect(p.clips.find((c) => c.id === "v1a")!.zoomKeys).toBeUndefined();
    const split = splitClip(next, "v1a", 4);
    const parts = split.clips.filter((c) => c.trackId === "V1" && c.mediaId === "m1" && c.srcIn < 10);
    expect(parts).toHaveLength(2);
    for (const c of parts) expect(c.zoomKeys).toHaveLength(2);
  });
});

describe("insertZoomKey（在預覽拖框加關鍵幀）", () => {
  const k = (src: number, scale = 2) => ({ src, scale, cx: 0.5, cy: 0.5 });
  it("第一次：同時建 2 秒後同一個框（不超過片段結尾）", () => {
    expect(insertZoomKey([], k(3), 10).map((x) => x.src)).toEqual([3, 5]);
    expect(insertZoomKey([], k(9), 10).map((x) => x.src)).toEqual([9, 10]);
  });
  it("之後：一格之內取代，否則依時間插入", () => {
    const keys = [k(3), k(5)];
    expect(insertZoomKey(keys, k(5.01, 3), 10).map((x) => [x.src, x.scale])).toEqual([[3, 2], [5.01, 3]]);
    expect(insertZoomKey(keys, k(4, 3), 10).map((x) => x.src)).toEqual([3, 4, 5]);
  });
});
