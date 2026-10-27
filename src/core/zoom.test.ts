import { describe, expect, it } from "vitest";
import { framePlan } from "../compositor/framePlan";
import { makeProject } from "./fixtures";
import { applyEdits } from "./history";
import type { ZoomRegion } from "./model";
import { centerAt, ease, moveZoom, progress, rampSeconds, trimZoom, zoomCrop, zoomFromRange, zoomState } from "./zoom";

// 局部放大（spec §5.19，照字導字演）：數學照搬原專案 backend/zoom_math.py 與它的測試（格數 ÷ 30 換成秒）。

/** 建一個放大區段 */
function region(partial: Partial<ZoomRegion>): ZoomRegion {
  return { id: "z1", mediaId: "m1", start: 0, end: 10, w: 0.5, path: [{ src: 0, cx: 0.5, cy: 0.5 }], enabled: true, ...partial };
}

describe("原專案 zoom_math 的對照", () => {
  it("頭尾緩動：固定 1 秒；區間短於 2 秒時取一半", () => {
    expect(rampSeconds(0, 10)).toBe(1);
    expect(rampSeconds(0, 40 / 30)).toBeCloseTo(20 / 30);
  });

  it("ease：端點與對稱（ease-in-out quad）", () => {
    expect(ease(0)).toBe(0);
    expect(ease(1)).toBe(1);
    expect(ease(0.5)).toBeCloseTo(0.5);
    expect(ease(0.25) + ease(0.75)).toBeCloseTo(1);
  });

  it("progress：起點後漸入、終點前漸出、中段 1、區間外 0", () => {
    const [s, e, r] = [100 / 30, 400 / 30, 1];
    expect(progress(100 / 30, s, e, r)).toBe(0);
    expect(progress(130 / 30, s, e, r)).toBeCloseTo(1);
    expect(progress(250 / 30, s, e, r)).toBe(1);
    expect(progress(400 / 30, s, e, r)).toBe(0);
    expect(progress(115 / 30, s, e, r)).toBeCloseTo(0.5);
    expect(progress(385 / 30, s, e, r)).toBeCloseTo(0.5);
    expect(progress(50 / 30, s, e, r)).toBe(0);
    expect(progress(500 / 30, s, e, r)).toBe(0);
  });

  it("centerAt：第一點前與最後一點後停住；兩點相同停住、不同時 ease 移動", () => {
    const path = [{ src: 10, cx: 0.3, cy: 0.5 }, { src: 500 / 30, cx: 0.3, cy: 0.5 }, { src: 700 / 30, cx: 0.7, cy: 0.5 }, { src: 30, cx: 0.7, cy: 0.75 }];
    expect(centerAt(path, 100 / 30)).toEqual({ cx: 0.3, cy: 0.5 });
    expect(centerAt(path, 400 / 30)).toEqual({ cx: 0.3, cy: 0.5 });
    expect(centerAt(path, 600 / 30).cx).toBeCloseTo(0.5);
    expect(centerAt(path, 650 / 30).cx).toBeCloseTo(0.3 + 0.4 * ease(0.75));
    expect(centerAt(path, 700 / 30)).toEqual({ cx: 0.7, cy: 0.5 });
    expect(centerAt(path, 800 / 30).cy).toBeCloseTo(0.625);
    expect(centerAt(path, 40)).toEqual({ cx: 0.7, cy: 0.75 });
  });

  it("zoomState：1.95 倍拖到最右上角，中段看的正是那一角；區間外是原畫面", () => {
    const w = 1 / 1.95;
    const z = region({ start: 0, end: 10, w, path: [{ src: 0, cx: 1 - w / 2, cy: w / 2 }] });
    const mid = zoomState(z, 5);
    expect(mid.scale).toBeCloseTo(1.95);
    expect(mid.cx).toBeCloseTo(1 - w / 2);
    expect(mid.cy).toBeCloseTo(w / 2);
    expect(zoomCrop(mid).x + zoomCrop(mid).w).toBeCloseTo(1);
    expect(zoomCrop(mid).y).toBeCloseTo(0);
    expect(zoomState(z, 0)).toEqual({ scale: 1, cx: 0.5, cy: 0.5 });
  });

  it("zoomState 用路徑的中心：中心已移到 0.75 時看的是 0.75", () => {
    const z = region({ start: 0, end: 20, w: 0.5, path: [{ src: 0, cx: 0.5, cy: 0.5 }, { src: 10, cx: 0.75, cy: 0.5 }] });
    const s = zoomState(z, 15);
    expect(s.scale).toBeCloseTo(2);
    expect(s.cx).toBeCloseTo(0.75);
  });
});

describe("推進中的倍率與中心（原專案的平移公式換算）", () => {
  it("漸入一半：倍率在 1 與 1/w 之間，看的中心在畫面中央與目標之間", () => {
    const z = region({ start: 0, end: 10, w: 0.25, path: [{ src: 0, cx: 0.2, cy: 0.5 }] });
    const s = zoomState(z, 0.5);
    expect(s.scale).toBeCloseTo(1 + 3 * 0.5);
    expect(s.cx).toBeGreaterThan(0.2);
    expect(s.cx).toBeLessThan(0.5);
  });
});

describe("編輯", () => {
  it("zoomFromRange：時間軸範圍 → 這段 V1 片段的素材範圍、預設框寬 0.5、一個路徑點在中央", () => {
    const p = makeProject();
    // v1b：時間軸 10～20 秒＝素材 20～30 秒
    const z = zoomFromRange(p, { start: 12, end: 15 }, "zx")!;
    expect(z).toMatchObject({ id: "zx", mediaId: "m1", start: 22, end: 25, w: 0.5, enabled: true });
    expect(z.path).toEqual([{ src: 22, cx: 0.5, cy: 0.5 }]);
    // 跨到下一個片段：夾在起點所在的片段裡
    expect(zoomFromRange(p, { start: 18, end: 24 }, "zy")!.end).toBe(30);
  });

  it("moveZoom 平移起訖與所有路徑點（夾在片段的素材範圍內）；trimZoom 只改起訖、路徑點夾回範圍", () => {
    const z = region({ start: 2, end: 4, path: [{ src: 2, cx: 0.5, cy: 0.5 }, { src: 3, cx: 0.6, cy: 0.5 }] });
    const moved = moveZoom(z, 1, 0, 10);
    expect([moved.start, moved.end, moved.path[1].src]).toEqual([3, 5, 4]);
    expect(moveZoom(z, 20, 0, 10).end).toBe(10);
    const trimmed = trimZoom(z, "start", 3.5, 0, 10);
    expect(trimmed.start).toBe(3.5);
    expect(trimmed.path.every((p) => p.src >= 3.5)).toBe(true);
  });

  it("framePlan：放大區段內的影像圖層帶裁切範圍；停用的不放大", () => {
    const p = makeProject();
    p.zooms = [region({ mediaId: "m1", start: 22, end: 26, w: 0.5, path: [{ src: 22, cx: 0.5, cy: 0.5 }] })];
    // 時間軸 14 秒＝素材 24 秒（中段）
    expect(framePlan(p, 14).find((l) => l.clipId === "v1b")!.crop).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    expect(framePlan(p, 11).find((l) => l.clipId === "v1b")!.crop).toBeUndefined();
    p.zooms[0].enabled = false;
    expect(framePlan(p, 14).find((l) => l.clipId === "v1b")!.crop).toBeUndefined();
  });

  it("addZoom／setZoom／deleteZoom 編輯，可以復原", () => {
    const p = makeProject();
    const added = applyEdits(p, [{ kind: "addZoom", zoom: region({}) }]);
    expect(added.zooms).toHaveLength(1);
    const changed = applyEdits(added, [{ kind: "setZoom", zoom: region({ w: 0.3 }) }]);
    expect(changed.zooms![0].w).toBe(0.3);
    expect(applyEdits(changed, [{ kind: "deleteZoom", zoomId: "z1" }]).zooms).toHaveLength(0);
    expect(p.zooms ?? []).toHaveLength(0);
  });
});
