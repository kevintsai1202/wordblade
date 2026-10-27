import { emptyProject } from "../core/media";
import { describe, expect, it } from "vitest";
import { makeProject } from "../core/fixtures";
import { formatTimecode, keyToAction, reducer, initialState, projectDuration, snapTime } from "./state";

describe("formatTimecode", () => {
  it("時:分:秒:格，格數四捨五入（currentTime 只到微秒，floor 會卡格）", () => {
    expect(formatTimecode(0, 30)).toBe("00:00:00:00");
    expect(formatTimecode(151 / 30, 30)).toBe("00:00:05:01");
    expect(formatTimecode(3661.5, 30)).toBe("01:01:01:15");
  });
});

describe("reducer", () => {
  it("commit 後可以 undo／redo", () => {
    let s = initialState(makeProject());
    s = reducer(s, { type: "commit", edits: [{ kind: "move", clipId: "v2", start: 3 }] });
    expect(s.history.present.clips.find((c) => c.id === "v2")!.start).toBe(3);
    s = reducer(s, { type: "undo" });
    expect(s.history.present.clips.find((c) => c.id === "v2")!.start).toBe(12);
    s = reducer(s, { type: "redo" });
    expect(s.history.present.clips.find((c) => c.id === "v2")!.start).toBe(3);
  });

  it("seek 不會小於 0、不超過片長", () => {
    let s = initialState(makeProject());
    s = reducer(s, { type: "seek", time: -5 });
    expect(s.playhead).toBe(0);
    s = reducer(s, { type: "seek", time: 999 });
    expect(s.playhead).toBe(30);
  });

  it("選取的片段被刪掉後取消選取", () => {
    let s = initialState(makeProject());
    s = reducer(s, { type: "select", clipId: "v1b" });
    s = reducer(s, { type: "deleteSelected" });
    expect(s.selectedClipId).toBeNull();
    expect(s.history.present.clips.some((c) => c.id === "v1b")).toBe(false);
  });
});

describe("播放（Space、J／K／L）", () => {
  const base = initialState(makeProject());
  const key = (k: string) => ({ key: k, ctrlKey: false, shiftKey: false });

  it("Space 播放／暫停", () => {
    expect(keyToAction(key(" "), base)).toEqual({ type: "play", rate: 1 });
    expect(keyToAction(key(" "), { ...base, playing: true })).toEqual({ type: "pause" });
  });

  it("L 前進，連按加速 2／4／8 倍；J 倒退同理；K 停", () => {
    expect(keyToAction(key("l"), base)).toEqual({ type: "play", rate: 1 });
    expect(keyToAction(key("l"), { ...base, playing: true, rate: 1 })).toEqual({ type: "play", rate: 2 });
    expect(keyToAction(key("l"), { ...base, playing: true, rate: 8 })).toEqual({ type: "play", rate: 8 });
    expect(keyToAction(key("j"), { ...base, playing: true, rate: 2 })).toEqual({ type: "play", rate: -1 });
    expect(keyToAction(key("j"), { ...base, playing: true, rate: -1 })).toEqual({ type: "play", rate: -2 });
    expect(keyToAction(key("k"), { ...base, playing: true })).toEqual({ type: "pause" });
  });

  it("tick 推進播放頭；走到片尾或片頭就停", () => {
    let s = reducer(base, { type: "play", rate: 1 });
    s = reducer(s, { type: "tick", time: 12 });
    expect([s.playhead, s.playing]).toEqual([12, true]);
    s = reducer(s, { type: "tick", time: 99 });
    expect([s.playhead, s.playing]).toEqual([30, false]);
    s = reducer(reducer(s, { type: "play", rate: -1 }), { type: "tick", time: -1 });
    expect([s.playhead, s.playing]).toEqual([0, false]);
  });
});

describe("snapTime（吸附）", () => {
  const s = { ...initialState(makeProject()), playhead: 15 };

  it("靠近播放頭或片段邊界（門檻內）就吸過去", () => {
    expect(snapTime(14.9, s, 0.2)).toBe(15);
    expect(snapTime(20.15, s, 0.2)).toBe(20);
  });

  it("太遠不吸", () => {
    expect(snapTime(17, s, 0.2)).toBe(17);
  });

  it("可以排除正在拖的片段自己的邊界", () => {
    // v2 在 12～17：拖 v2 時不該吸到它自己的 12
    expect(snapTime(12.1, s, 0.2, "v2")).toBe(12.1);
  });
});

describe("keyToAction（Resolve 熱鍵）", () => {
  const s = { ...initialState(makeProject()), playhead: 15, selectedClipId: "v1b" };
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; shiftKey: boolean }> = {}) => ({ key: k, ctrlKey: false, shiftKey: false, ...mods });

  it("Ctrl+Z 復原、Ctrl+Shift+Z 重做", () => {
    expect(keyToAction(key("z", { ctrlKey: true }), s)).toEqual({ type: "undo" });
    expect(keyToAction(key("Z", { ctrlKey: true, shiftKey: true }), s)).toEqual({ type: "redo" });
  });

  it("Ctrl+B 在播放頭切開播放頭下的 V1 片段", () => {
    expect(keyToAction(key("b", { ctrlKey: true }), s)).toEqual({ type: "commit", edits: [{ kind: "split", clipId: "v1b", t: 15 }] });
  });

  it("Delete 漣漪刪除選取的片段", () => {
    expect(keyToAction(key("Delete"), s)).toEqual({ type: "deleteSelected" });
  });

  it("← → 逐格", () => {
    expect(keyToAction(key("ArrowRight"), s)).toEqual({ type: "seek", time: 15 + 1 / 30 });
    expect(keyToAction(key("ArrowLeft"), s)).toEqual({ type: "seek", time: 15 - 1 / 30 });
  });

  it("↑ ↓ 跳到上／下一個剪輯點", () => {
    expect(keyToAction(key("ArrowDown"), s)).toEqual({ type: "seek", time: 20 });
    expect(keyToAction(key("ArrowUp"), s)).toEqual({ type: "seek", time: 10 });
  });

  it("沒對應的鍵回 null", () => {
    expect(keyToAction(key("q"), s)).toBeNull();
  });
});

describe("匯入素材與載入專案", () => {
  it("importMedia 加進素材庫但不進復原歷史", () => {
    const s0 = reducer(initialState(makeProject()), { type: "commit", edits: [{ kind: "delete", clipId: "v2" }] });
    const s1 = reducer(s0, { type: "importMedia", media: [{ id: "new", kind: "audio", duration: 3 }] });
    expect(s1.history.past).toHaveLength(1);
    expect(s1.history.present.media.some((m) => m.id === "new")).toBe(true);
    expect(reducer(s1, { type: "undo" }).history.present.media.some((m) => m.id === "new")).toBe(true);
  });

  it("load 換成新專案：清空歷史、播放頭回 0、停止播放", () => {
    const s0 = reducer(reducer(initialState(makeProject()), { type: "seek", time: 5 }), { type: "play", rate: 1 });
    const s1 = reducer(s0, { type: "load", project: emptyProject() });
    expect(s1.history.past).toEqual([]);
    expect(s1.history.present.clips).toEqual([]);
    expect([s1.playhead, s1.playing, s1.selectedClipId]).toEqual([0, false, null]);
  });
});

describe("patchMedia（代理檔做好時記進素材，不進復原歷史）", () => {
  it("改每一份快照裡那支素材的欄位，歷史長度不變", () => {
    const s0 = reducer(initialState(makeProject()), { type: "commit", edits: [{ kind: "delete", clipId: "v2" }] });
    const s1 = reducer(s0, { type: "patchMedia", id: "m1", patch: { proxyPath: "C:/p/m1.mp4" } });
    expect(s1.history.past).toHaveLength(1);
    expect(s1.history.present.media.find((m) => m.id === "m1")!.proxyPath).toBe("C:/p/m1.mp4");
    expect(reducer(s1, { type: "undo" }).history.present.media.find((m) => m.id === "m1")!.proxyPath).toBe("C:/p/m1.mp4");
  });

  it("找不到素材時不變", () => {
    const s0 = initialState(makeProject());
    expect(reducer(s0, { type: "patchMedia", id: "nope", patch: { proxyPath: "x" } }).history.present).toBe(s0.history.present);
  });
});

describe("選取特效", () => {
  it("選特效會取消選片段；Delete 刪掉選取的特效，Ctrl+Z 復原", () => {
    let s = reducer(initialState(makeProject()), { type: "select", clipId: "v2" });
    s = reducer(s, { type: "selectEffect", effectId: "e1" });
    expect([s.selectedClipId, s.selectedEffectId]).toEqual([null, "e1"]);
    expect(keyToAction({ key: "Delete", ctrlKey: false, shiftKey: false }, s)).toEqual({ type: "deleteSelected" });
    s = reducer(s, { type: "deleteSelected" });
    expect(s.history.present.effects).toHaveLength(0);
    expect(s.selectedEffectId).toBeNull();
    expect(reducer(s, { type: "undo" }).history.present.effects).toHaveLength(1);
  });
});

describe("projectDuration 含特效", () => {
  it("特效結束得比片段晚時，成片長度算到特效結束", () => {
    const p = { ...emptyProject(), effects: [{ id: "x", kind: "anim2d" as const, start: 1, end: 3.5, pluginId: "", params: {}, anchorIds: [] }] };
    expect(projectDuration(p)).toBe(3.5);
  });
});
