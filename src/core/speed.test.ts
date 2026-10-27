import { describe, expect, it } from "vitest";
import { makeProject } from "./fixtures";
import { applyEdits } from "./history";
import { clipEnd } from "./timeline";
import { setClipSpeed } from "./speed";

// 片段變速（spec §5.20，P1-6）：連動片段一起變速；V1 重排，其他軌道在它原本結束點之後開始的一起平移，跨在中間的不動
// （開發者 2026-10-28 選定）。fixture：V1 v1a 0～10、v1b 10～20、v1c 20～30；A1 a1a／a1b／a1c 同位置；V2 v2 12～17；
// A2 配樂 a2 0～30；特效 e1 8～12；定位點 an1 15、an2 9.5。

const byId = (p: ReturnType<typeof makeProject>, id: string) => p.clips.find((c) => c.id === id)!;

describe("setClipSpeed", () => {
  it("V1 片段 2 倍：長度減半、連動的 A1 一起變速；後面的 V1 接上、其他軌道在原結束點之後的往前移", () => {
    const p = setClipSpeed(makeProject(), "v1a", 2);
    expect(byId(p, "v1a").speed).toBe(2);
    expect(clipEnd(byId(p, "v1a"))).toBe(5);
    expect(byId(p, "a1a").speed).toBe(2);
    expect(clipEnd(byId(p, "a1a"))).toBe(5);
    expect(byId(p, "v1b").start).toBe(5);
    expect(byId(p, "a1b").start).toBe(5);
    expect(byId(p, "v2").start).toBe(7);
    expect(p.anchors.find((a) => a.id === "an1")!.time).toBe(10);
    // 跨在中間的不動：配樂、特效 e1（8～12）、定位點 an2（9.5）
    expect(byId(p, "a2").start).toBe(0);
    expect(clipEnd(byId(p, "a2"))).toBe(30);
    expect(p.effects[0]).toMatchObject({ start: 8, end: 12 });
    expect(p.anchors.find((a) => a.id === "an2")!.time).toBe(9.5);
  });

  it("0.5 倍：長度加倍、後面的往後移", () => {
    const p = setClipSpeed(makeProject(), "v1a", 0.5);
    expect(clipEnd(byId(p, "v1a"))).toBe(20);
    expect(byId(p, "a1b").start).toBe(20);
    expect(byId(p, "v1c").start).toBe(30);
  });

  it("選 A1 的片段也一樣（連動的 V1 一起變，照樣重排）", () => {
    const a = setClipSpeed(makeProject(), "a1a", 2);
    const b = setClipSpeed(makeProject(), "v1a", 2);
    expect(a.clips.map((c) => [c.id, c.start, c.speed])).toEqual(b.clips.map((c) => [c.id, c.start, c.speed]));
  });

  it("鎖定的軌道不移動；特效在原結束點之後開始的整段平移", () => {
    const base = makeProject();
    base.tracks = base.tracks.map((t) => (t.id === "V2" ? { ...t, locked: true } : t));
    base.effects = [{ ...base.effects[0], start: 11, end: 13 }];
    const p = setClipSpeed(base, "v1a", 2);
    expect(byId(p, "v2").start).toBe(12);
    expect(p.effects[0]).toMatchObject({ start: 6, end: 8 });
  });

  it("倍數夾在 0.25～4、取到小數兩位；太短時不低於最短片段長度；定格片段不變", () => {
    expect(byId(setClipSpeed(makeProject(), "v1a", 8), "v1a").speed).toBe(4);
    expect(byId(setClipSpeed(makeProject(), "v1a", 0.1), "v1a").speed).toBe(0.25);
    expect(byId(setClipSpeed(makeProject(), "v1a", 1.234), "v1a").speed).toBe(1.23);
    const tiny = makeProject();
    tiny.clips = tiny.clips.map((c) => (c.id === "v1a" ? { ...c, srcOut: 0.2 } : c));
    const fast = byId(setClipSpeed(tiny, "v1a", 4), "v1a");
    expect(clipEnd(fast) - fast.start).toBeGreaterThanOrEqual(0.1 - 1e-9);
    const frozen = makeProject();
    frozen.clips = frozen.clips.map((c) => (c.id === "v1a" ? { ...c, freeze: { at: 1, hold: 2 } } : c));
    expect(setClipSpeed(frozen, "v1a", 2)).toBe(frozen);
  });

  it("淡入、淡出各自不超過變短後的片段（和修邊同一個規則）；setSpeed 編輯一次復原", () => {
    const base = makeProject();
    base.clips = base.clips.map((c) => (c.id === "v1a" ? { ...c, fadeIn: 4, fadeOut: 4 } : c));
    const p = applyEdits(base, [{ kind: "setSpeed", clipId: "v1a", speed: 4 }]);
    const c = byId(p, "v1a");
    expect(c.fadeIn).toBeLessThanOrEqual(clipEnd(c) - c.start + 1e-9);
    expect(c.fadeOut).toBeLessThanOrEqual(clipEnd(c) - c.start + 1e-9);
    expect(byId(base, "v1a").speed).toBe(1);
  });
});
