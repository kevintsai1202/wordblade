import { describe, expect, it } from "vitest";
import { makeProject } from "../core/fixtures";
import { applyEdits } from "../core/history";
import type { Effect, Project, Suggestion } from "../core/model";
import { applyScript, type ApplyDeps } from "./apply";

// 剪輯腳本一次套用（docs/plan-10-29-director2.md §5）：素材時間的（剪、改字、遮罩、放大）先套 → 特效與 3D 用「剪過之後」的時間軸範圍 →
// 字幕樣式、配樂 → 片頭最後（漣漪插入，前面的東西一起往後移）。全部合成一筆編輯（一次 Ctrl+Z）；某一項失敗就跳過它、其他照套。
// fixture：m1 在 V1 有兩段（素材 0～10 → 時間軸 0～10、素材 20～30 → 時間軸 10～20）。
const sug = (id: string, kind: Suggestion["kind"], start: number, end: number, payload: Record<string, unknown> = {}): Suggestion =>
  ({ id, mediaId: "m1", kind, start, end, payload, reason: "r", status: "pending", purpose: "p" });

/** 記下各個 AI 步驟收到什麼的假依賴 */
function fakeDeps(over: Partial<ApplyDeps> = {}) {
  const calls: string[] = [];
  const effect = (id: string, start: number, end: number): Effect => ({ id, kind: "anim2d", start, end, pluginId: "h", params: {}, anchorIds: [] });
  const deps: ApplyDeps = {
    mask: async (s) => { calls.push(`mask ${s.id}`); return [{ id: `mk-${s.id}`, mediaId: "m1", prompt: "API key", label: "API key", samples: [{ t: s.start, box: [0, 0, 0.1, 0.1], mask: null }], interval: 0.5, effect: { kind: "mosaic", strength: 16 }, expand: 20, enabled: true }]; },
    effect: async (s, span) => { calls.push(`effect ${s.id} ${span.start}-${span.end}`); return { effect: effect(`fx-${s.id}`, span.start, span.end), plugins: [] }; },
    scene: async (s, span) => { calls.push(`scene ${s.id} ${span.start}-${span.end}`); return { effect: { ...effect(`sc-${s.id}`, span.start, span.end), kind: "scene3d" }, plugins: [] }; },
    music: async (s) => { calls.push(`music ${s.id}`); return "mus"; },
    intro: async (s) => { calls.push(`intro ${s.id}`); return null; },
    ...over,
  };
  return { deps, calls };
}

describe("applyScript", () => {
  it("剪先套，特效與 3D 用剪過之後的時間軸範圍；全部標成已採用；結果是一串編輯", async () => {
    const base: Project = { ...makeProject(), suggestions: [] };
    const items = [
      sug("e1", "effect", 24, 26, { description: "d" }),
      sug("c1", "cut", 2, 4),
      sug("t1", "transition", 20, 23, { scene: "desk-reveal" }),
      sug("z1", "zoom", 5, 8, { w: 0.4, path: [{ src: 5, cx: 0.3, cy: 0.3 }, { src: 7, cx: 0.4, cy: 0.5 }] }),
      sug("k1", "captionStyle", 0, 30, { karaoke: "fill" }),
    ];
    base.suggestions = items;
    const { deps, calls } = fakeDeps();
    const { edits, failed } = await applyScript(base, items, deps);
    expect(failed).toEqual([]);
    // 剪掉素材 2～4 秒後，素材 24～26 在時間軸 12～14、素材 20～23 在 8～11
    expect(calls).toEqual(["scene t1 8-11", "effect e1 12-14"]);
    const p = applyEdits(base, edits);
    expect(p.suggestions.every((s) => s.status === "applied")).toBe(true);
    expect(p.effects.map((e) => e.id)).toEqual(expect.arrayContaining(["fx-e1", "sc-t1"]));
    expect(p.effects).toHaveLength(base.effects.length + 2);
    expect(p.zooms?.[0].path).toEqual([{ src: 5, cx: 0.3, cy: 0.3 }, { src: 7, cx: 0.4, cy: 0.5 }]);
    expect(p.captionStyle?.karaoke).toBe("fill");
  });

  it("某一項失敗就跳過它（狀態不變），其他照套；配樂放在配樂軌時間軸開頭", async () => {
    const base: Project = { ...makeProject() };
    base.media = [...base.media, { id: "mus2", kind: "audio", duration: 16, audio: true }];
    const items = [sug("e1", "effect", 24, 26, { description: "d" }), sug("m1x", "music", 0, 30, { description: "lofi" }), sug("k1", "mask", 3, 5, { target: "API key" })];
    base.suggestions = items;
    const { deps } = fakeDeps({ effect: async () => { throw new Error("Vibe failed"); }, music: async () => "mus2" });
    const { edits, failed } = await applyScript(base, items, deps);
    expect(failed).toEqual([{ id: "e1", message: "Vibe failed" }]);
    const p = applyEdits(base, edits);
    expect(p.suggestions.find((s) => s.id === "e1")!.status).toBe("pending");
    expect(p.masks.map((m) => m.id)).toEqual(["mk-k1"]);
    const music = p.clips.filter((c) => c.mediaId === "mus2");
    expect(music).toHaveLength(1);
    expect(music[0]).toMatchObject({ trackId: "A2", start: 0 });
  });

  it("不能套的（改字的詞不存在、範圍已被剪掉）列在失敗裡", async () => {
    const base: Project = { ...makeProject() };
    const items = [sug("f1", "fix", 1, 2, { wordIds: ["nope"], text: "x" }), sug("e1", "effect", 12, 14, { description: "d" })];
    base.suggestions = items;
    const { deps } = fakeDeps();
    const { failed } = await applyScript(base, items, deps);
    expect(failed.map((f) => f.id)).toEqual(["f1", "e1"]);
  });
});
