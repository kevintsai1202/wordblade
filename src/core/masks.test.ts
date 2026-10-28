import { describe, expect, it } from "vitest";
import { makeProject } from "./fixtures";
import { applyEdits } from "./history";
import { maskSourceRange } from "./masks";
import type { MaskObject } from "./model";

// SAM 遮罩的專案編輯（§5.3）：加入、改設定、刪除都是可復原的編輯；範圍換成素材時間（照 zoomFromRange：起點所在的 V1 片段）。
const mask = (id: string): MaskObject => ({
  id, mediaId: "m1", prompt: "human face", label: "human face 1", interval: 0.1, expand: 10, enabled: true,
  effect: { kind: "mosaic", strength: 24 }, samples: [{ t: 1, box: [0.1, 0.1, 0.2, 0.2], mask: null }],
});

describe("masks", () => {
  it("addMasks／setMask／deleteMasks", () => {
    let p = applyEdits(makeProject(), [{ kind: "addMasks", masks: [mask("a"), mask("b")] }]);
    expect(p.masks.map((m) => m.id)).toEqual(["a", "b"]);
    p = applyEdits(p, [{ kind: "setMask", mask: { ...mask("a"), enabled: false, effect: { kind: "blur", strength: 30 } } }]);
    expect(p.masks[0]).toMatchObject({ enabled: false, effect: { kind: "blur" } });
    p = applyEdits(p, [{ kind: "deleteMasks", ids: ["a"] }]);
    expect(p.masks.map((m) => m.id)).toEqual(["b"]);
  });

  it("時間軸範圍 → 素材時間（起點所在的 V1 片段，終點夾在片段內）；沒有 V1 片段回 null", () => {
    const p = makeProject();
    const v1a = p.clips.find((c) => c.id === "v1a")!;
    const r = maskSourceRange(p, { start: 2, end: 15 })!;
    expect(r.mediaId).toBe(v1a.mediaId);
    expect(r.start).toBeCloseTo(v1a.srcIn + 2, 6);
    expect(r.end).toBeCloseTo(v1a.srcOut, 6);
    expect(maskSourceRange(p, { start: 500, end: 501 })).toBeNull();
  });
});
