import { describe, expect, it } from "vitest";
import { checkProposal } from "./plane3d";

const flatKey = { anchor: "start", t: 0, rx: 0, ry: 0, rz: 0, size: 0.8, px: 0, py: 0, ease: "inOut" };

describe("checkProposal（用原專案的姿勢數學檢查 AI 的提議）", () => {
  it("沒回的欄位維持原值；合格的提議沒有錯誤", () => {
    const { merged, errors } = checkProposal({ keys: [flatKey], edges: true, background: "studio" }, { keys: [{ ...flatKey, ry: 40 }] }, 6, 1920, 1080);
    expect(errors).toEqual([]);
    expect(merged.background).toBe("studio");
    expect((merged.keys as { ry: number }[])[0].ry).toBe(40);
  });

  it("時間不遞增、姿勢超出範圍都會回報錯誤", () => {
    const bad = checkProposal({ edges: true }, { keys: [{ ...flatKey, t: 2 }, { ...flatKey, t: 1 }] }, 6, 1920, 1080);
    expect(bad.errors.map((e) => e.message).join()).toContain("遞增");
    const tooClose = checkProposal({ edges: true }, { keys: [{ ...flatKey, size: 3 }] }, 6, 1920, 1080);  // 超出範圍的姿勢路徑不可用
    expect(tooClose.errors.map((e) => e.message).join()).toContain("姿勢");
  });
});
