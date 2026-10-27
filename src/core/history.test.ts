import { describe, expect, it } from "vitest";
import { makeProject } from "./fixtures";
import { amend, applyEdits, canRedo, canUndo, commit, createHistory, redo, undo } from "./history";
import { addMedia } from "./media";

describe("applyEdits", () => {
  it("依序套用多個編輯", () => {
    const out = applyEdits(makeProject(), [
      { kind: "split", clipId: "v1b", t: 15 },
      { kind: "move", clipId: "v2", start: 3 },
    ]);
    expect(out.clips.some((c) => c.id === "v1b-2")).toBe(true);
    expect(out.clips.find((c) => c.id === "v2")!.start).toBe(3);
  });

  it("沒有任何改變時回傳同一個物件", () => {
    const p = makeProject();
    expect(applyEdits(p, [{ kind: "split", clipId: "v1b", t: 99 }])).toBe(p);
  });
});

describe("復原／重做", () => {
  it("一次 commit 多個編輯＝一筆歷史，一次 undo 全部還原", () => {
    const p = makeProject();
    let h = createHistory(p);
    h = commit(h, [
      { kind: "cutWords", wordIds: ["w2"] },
      { kind: "cutWords", wordIds: ["w4"] },
    ]);
    expect(h.present).not.toBe(p);
    expect(canUndo(h)).toBe(true);
    h = undo(h);
    expect(h.present).toBe(p);
    expect(canRedo(h)).toBe(true);
  });

  it("redo 回到 undo 前的狀態；新的 commit 清掉 redo", () => {
    let h = commit(createHistory(makeProject()), [{ kind: "move", clipId: "v2", start: 3 }]);
    const after = h.present;
    h = redo(undo(h));
    expect(h.present).toBe(after);
    h = commit(undo(h), [{ kind: "move", clipId: "v2", start: 5 }]);
    expect(canRedo(h)).toBe(false);
  });

  it("沒有改變的 commit 不留歷史", () => {
    const h = commit(createHistory(makeProject()), [{ kind: "split", clipId: "v1b", t: 99 }]);
    expect(canUndo(h)).toBe(false);
  });

  it("沒有沒改到的部分共用（結構共享）", () => {
    const p = makeProject();
    const h = commit(createHistory(p), [{ kind: "move", clipId: "v2", start: 3 }]);
    expect(h.present.words).toBe(p.words);
  });
});

describe("amend（匯入素材不進復原歷史）", () => {
  it("套到過去、目前、未來每一份快照，不新增歷史", () => {
    let h = createHistory(makeProject());
    h = commit(h, [{ kind: "delete", clipId: "v2" }]);
    h = commit(h, [{ kind: "delete", clipId: "a2" }]);
    h = undo(h);
    const media = { id: "x", kind: "audio" as const, duration: 1 };
    const out = amend(h, (p) => addMedia(p, [media]));
    expect(out.past).toHaveLength(h.past.length);
    expect(out.future).toHaveLength(h.future.length);
    for (const snap of [...out.past, out.present, ...out.future]) expect(snap.media.some((m) => m.id === "x")).toBe(true);
    expect(undo(out).present.media.some((m) => m.id === "x")).toBe(true);
  });

  it("place 編輯：拖素材到時間軸可以復原", () => {
    const h = commit(createHistory(addMedia(makeProject(), [{ id: "x", kind: "audio", duration: 2 }])), [{ kind: "place", mediaId: "x", trackId: "A2", t: 50 }]);
    expect(h.present.clips.some((c) => c.mediaId === "x")).toBe(true);
    expect(undo(h).present.clips.some((c) => c.mediaId === "x")).toBe(false);
  });
});
