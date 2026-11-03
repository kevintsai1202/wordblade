import { describe, expect, it } from "vitest";
import { commit, createHistory, undo } from "./history";
import { makeProject } from "./fixtures";

// 從專案移除素材（2026-11-01：找不到的舊素材要能拿掉）：素材與它在時間軸上的片段、逐字稿、建議一起拿掉，一次復原
describe("移除素材", () => {
  it("素材與它的片段一起拿掉；其他素材的片段不動；Ctrl+Z 回來", () => {
    const p = makeProject();
    const target = p.media[0].id;
    const others = p.clips.filter((c) => c.mediaId !== target).map((c) => c.id);
    const h = commit(createHistory(p), [{ kind: "removeMedia", mediaId: target }]);
    expect(h.present.media.some((m) => m.id === target)).toBe(false);
    expect(h.present.clips.map((c) => c.id)).toEqual(others);
    expect(undo(h).present).toEqual(p);
  });
});
