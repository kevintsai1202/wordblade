import { describe, expect, it } from "vitest";
import { produce } from "immer";
import { makeClip, makeProject } from "./fixtures";
import type { Project } from "./model";
import {
  clipDuration,
  cutByWords,
  layoutV1,
  moveClip,
  rippleDelete,
  rippleInsertDraft,
  sourceToTimeline,
  splitClip,
  timelineToSource,
  trimClip,
} from "./timeline";

/** 取某個片段（找不到就讓測試失敗） */
function clip(p: Project, id: string) {
  const c = p.clips.find((x) => x.id === id);
  if (!c) throw new Error(`no clip ${id}`);
  return c;
}

/** 某條軌道上的片段，依起點排序，只留比對用的欄位 */
function track(p: Project, trackId: string) {
  return p.clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start)
    .map((c) => ({ id: c.id, srcIn: c.srcIn, srcOut: c.srcOut, start: c.start }));
}

describe("時間換算", () => {
  const fast = makeClip({ id: "c", mediaId: "m1", trackId: "V1", srcIn: 10, srcOut: 20, start: 5, speed: 2 });

  it("片段長度＝素材長度 ÷ 速度", () => {
    expect(clipDuration(fast)).toBe(5);
  });

  it("時間軸時間 → 素材時間（含變速）", () => {
    expect(timelineToSource(fast, 6)).toBe(12);
    expect(timelineToSource(fast, 5)).toBe(10);
  });

  it("素材時間 → 時間軸時間；不在片段範圍內回 null", () => {
    expect(sourceToTimeline(fast, 14)).toBe(7);
    expect(sourceToTimeline(fast, 9)).toBeNull();
    expect(sourceToTimeline(fast, 21)).toBeNull();
  });

  it("定格片段：長度是 hold，任何時間都對到同一格", () => {
    const freeze = makeClip({ id: "f", mediaId: "m1", trackId: "V1", srcIn: 7, srcOut: 7, start: 0, freeze: { at: 7, hold: 3 } });
    expect(clipDuration(freeze)).toBe(3);
    expect(timelineToSource(freeze, 2.5)).toBe(7);
  });
});

describe("layoutV1", () => {
  it("依順序與長度重算 V1 起點，首尾相接", () => {
    const p = makeProject();
    clip(p, "v1b").start = 13;
    clip(p, "v1c").start = 40;
    const out = layoutV1(p);
    expect(track(out, "V1").map((c) => c.start)).toEqual([0, 10, 20]);
  });
});

describe("rippleDelete（D25 跨軌規則）", () => {
  it("刪 [9, 11)：V1、A1 兩邊各剪一刀並補位，後面的片段左移 2 秒", () => {
    const out = rippleDelete(makeProject(), 9, 11);
    expect(track(out, "V1")).toEqual([
      { id: "v1a", srcIn: 0, srcOut: 9, start: 0 },
      { id: "v1b", srcIn: 21, srcOut: 30, start: 9 },
      { id: "v1c", srcIn: 0, srcOut: 10, start: 18 },
    ]);
    expect(track(out, "A1")).toEqual([
      { id: "a1a", srcIn: 0, srcOut: 9, start: 0 },
      { id: "a1b", srcIn: 21, srcOut: 30, start: 9 },
      { id: "a1c", srcIn: 0, srcOut: 10, start: 18 },
    ]);
  });

  it("疊加軌整段在刪除範圍之後：左移", () => {
    expect(clip(rippleDelete(makeProject(), 9, 11), "v2").start).toBe(10);
  });

  it("跨在刪除範圍上的配樂：剪掉那段，後半段變新片段並左移", () => {
    const out = rippleDelete(makeProject(), 9, 11);
    expect(track(out, "A2")).toEqual([
      { id: "a2", srcIn: 0, srcOut: 9, start: 0 },
      { id: "a2-2", srcIn: 11, srcOut: 30, start: 9 },
    ]);
  });

  it("鎖定的軌完全不動", () => {
    const p = makeProject();
    p.tracks.find((t) => t.id === "A2")!.locked = true;
    expect(track(rippleDelete(p, 9, 11), "A2")).toEqual([{ id: "a2", srcIn: 0, srcOut: 30, start: 0 }]);
  });

  it("跨在刪除範圍上的特效：長度減掉重疊部分，鏡頭關鍵幀依比例壓縮", () => {
    const e = rippleDelete(makeProject(), 9, 11).effects[0];
    expect([e.start, e.end]).toEqual([8, 10]);
    expect(e.cameraKeys!.map((k) => k.t)).toEqual([0, 2]);
  });

  it("時間軸定位點：範圍內刪除、之後的左移", () => {
    const out = rippleDelete(makeProject(), 9, 11);
    expect(out.anchors.map((a) => [a.id, a.time])).toEqual([["an1", 13]]);
  });

  it("素材時間的資料（逐字稿）不動", () => {
    const p = makeProject();
    expect(rippleDelete(p, 9, 11).words).toEqual(p.words);
  });

  it("範圍涵蓋整個片段：那個片段刪除，兩端的片段修邊", () => {
    const out = rippleDelete(makeProject(), 5, 22);
    expect(track(out, "V1")).toEqual([
      { id: "v1a", srcIn: 0, srcOut: 5, start: 0 },
      { id: "v1c", srcIn: 2, srcOut: 10, start: 5 },
    ]);
  });

  it("變速片段：依速度換算切點的素材時間", () => {
    const p = makeProject();
    clip(p, "v1b").speed = 2;
    clip(p, "v1b").srcOut = 40; // 素材 20～40、2 倍速 → 時間軸 10～20
    const out = rippleDelete(p, 12, 14);
    expect(track(out, "V1")[1]).toEqual({ id: "v1b", srcIn: 20, srcOut: 24, start: 10 });
    expect(track(out, "V1")[2]).toEqual({ id: "v1b-2", srcIn: 28, srcOut: 40, start: 12 });
  });

  it("不改到傳入的專案（純函式）", () => {
    const p = makeProject();
    const before = JSON.stringify(p);
    rippleDelete(p, 9, 11);
    expect(JSON.stringify(p)).toBe(before);
  });
});

describe("cutByWords（改字即剪）", () => {
  it("刪一個詞：詞的邊界前後各多剪 0.05 秒，但不剪進相鄰的詞", () => {
    // w1 1.0～1.5、w2 1.6～2.0、w3 2.5～3.0；刪 w2 → 剪素材時間 [max(1.55, 1.5), min(2.05, 2.5)) = [1.55, 2.05)
    const out = cutByWords(makeProject(), ["w2"]);
    expect(track(out, "V1").slice(0, 2)).toEqual([
      { id: "v1a", srcIn: 0, srcOut: 1.55, start: 0 },
      { id: "v1a-2", srcIn: 2.05, srcOut: 10, start: 1.55 },
    ]);
    expect(track(out, "A1").slice(0, 2)).toEqual([
      { id: "a1a", srcIn: 0, srcOut: 1.55, start: 0 },
      { id: "a1a-2", srcIn: 2.05, srcOut: 10, start: 1.55 },
    ]);
  });

  it("相鄰的詞貼太近：剪到相鄰詞的邊界為止", () => {
    // 刪 w1（1.0～1.5）：後一個詞 w2 從 1.6 開始 → 剪 [0.95, 1.55)
    const out = cutByWords(makeProject(), ["w1"]);
    expect(track(out, "V1").slice(0, 2)).toEqual([
      { id: "v1a", srcIn: 0, srcOut: 0.95, start: 0 },
      { id: "v1a-2", srcIn: 1.55, srcOut: 10, start: 0.95 },
    ]);
  });

  it("詞在第二個 V1 片段裡：換算到那個片段的時間軸位置，不吃掉前面的長空隙", () => {
    // w4 21～22 在 v1b（素材 20～30、時間軸 10～20）→ 剪素材 [20.95, 22.05)＝時間軸 [10.95, 12.05)
    const out = cutByWords(makeProject(), ["w4"]);
    expect(track(out, "V1").slice(1, 3)).toEqual([
      { id: "v1b", srcIn: 20, srcOut: 20.95, start: 10 },
      { id: "v1b-2", srcIn: 22.05, srcOut: 30, start: 10.95 },
    ]);
  });

  it("詞所在的素材不在 V1 上：不動", () => {
    const p = makeProject();
    p.words.push({ id: "wx", mediaId: "mus", text: "la", start: 1, end: 2 });
    expect(cutByWords(p, ["wx"]).clips).toEqual(p.clips);
  });
});

describe("splitClip", () => {
  it("在播放頭切開：前段到切點，後段是新片段", () => {
    const out = splitClip(makeProject(), "v1b", 15);
    expect(track(out, "V1").slice(1, 3)).toEqual([
      { id: "v1b", srcIn: 20, srcOut: 25, start: 10 },
      { id: "v1b-2", srcIn: 25, srcOut: 30, start: 15 },
    ]);
  });

  it("切點不在片段內：不動", () => {
    const p = makeProject();
    expect(splitClip(p, "v1b", 25)).toBe(p);
  });
});

describe("trimClip", () => {
  it("V1 修出點：後面的 V1 片段補位（漣漪修剪）", () => {
    const out = trimClip(makeProject(), "v1a", "out", 8);
    expect(track(out, "V1").map((c) => [c.id, c.srcOut, c.start])).toEqual([["v1a", 8, 0], ["v1b", 30, 8], ["v1c", 10, 18]]);
  });

  it("疊加軌修入點：起點與素材入點一起動，其他片段不動", () => {
    const out = trimClip(makeProject(), "v2", "in", 13);
    expect(clip(out, "v2")).toMatchObject({ srcIn: 51, start: 13, srcOut: 55 });
  });

  it("修邊不能超出素材長度", () => {
    const out = trimClip(makeProject(), "v1c", "out", 1000);
    expect(clip(out, "v1c").srcOut).toBe(300);
  });
});

describe("moveClip", () => {
  it("疊加軌：直接改起點", () => {
    expect(clip(moveClip(makeProject(), "v2", 3), "v2").start).toBe(3);
  });

  it("V1：依新位置重新排序，仍首尾相接", () => {
    const out = moveClip(makeProject(), "v1c", 0);
    expect(track(out, "V1").map((c) => [c.id, c.start])).toEqual([["v1c", 0], ["v1a", 10], ["v1b", 20]]);
  });
});

describe("漣漪剪輯時 2D 特效內部的時間（圖層起訖、音效時間點）", () => {
  /** 8～12 秒的 2D 特效：三個圖層、兩個音效（特效內的秒數） */
  function withAnim(): Project {
    const p = makeProject();
    p.effects = [{
      id: "a1", kind: "anim2d", start: 8, end: 12, pluginId: "box", anchorIds: [],
      params: {
        layers: [{ component: "box", params: {}, start: 0, end: 1.5 }, { component: "arrow", params: {}, start: 1.5, end: 4 }, { component: "check", params: {}, start: 1.2, end: null }],
        sounds: [{ component: "ding", params: {}, at: 0.5 }, { component: "pop", params: {}, at: 3.5 }],
      },
    }];
    return p;
  }

  it("刪除 9～11 秒：剪點之前不動、之後左移 2 秒、落在範圍內的收到剪點", () => {
    const e = rippleDelete(withAnim(), 9, 11).effects[0];
    expect([e.start, e.end]).toEqual([8, 10]);
    const layers = e.params.layers as { start: number; end: number | null }[];
    expect(layers.map((l) => [l.start, l.end])).toEqual([[0, 1], [1, 2], [1, null]]);
    expect((e.params.sounds as { at: number }[]).map((s) => s.at)).toEqual([0.5, 1.5]);
  });

  it("在 10 秒插入 2 秒：之後的圖層與音效右移", () => {
    const p = withAnim();
    const out = produce(p, (d) => { rippleInsertDraft(d, 10, 2); });
    const e = out.effects[0];
    expect([e.start, e.end]).toEqual([8, 14]);
    expect((e.params.layers as { end: number | null }[]).map((l) => l.end)).toEqual([1.5, 6, null]);
    expect((e.params.sounds as { at: number }[]).map((s) => s.at)).toEqual([0.5, 5.5]);
  });
});
