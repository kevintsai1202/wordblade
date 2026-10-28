import { describe, expect, it } from "vitest";
import { makeProject } from "../core/fixtures";
import { applyEdits } from "../core/history";
import type { Plugin } from "../core/model";
import { flipIntro } from "./flip";
import { flipEffect, insertIntro } from "./insert";

// 一鍵片頭插進時間軸（spec §5.23）：V1 開頭漣漪插入佔位素材、全畫面特效、A3 每聲一個音效片段、A2 配樂片段，一次編輯。
const plugin: Plugin = { hash: "flip-hash", kind: "3d", source: "builtin", component: { id: "flip-intro", params: { tone: { type: "enum", default: "duotone" } } } };
const plan = flipIntro({ imageIds: ["a", "b", "c", "a"], title: "My Talk", subtitle: "part 1", iconId: "logo", fps: 30, seed: 3 });

describe("flipEffect：特效參數", () => {
  it("圖片只列一次（含 icon），頁面與標題填圖用索引；時間表與標題都在參數裡", () => {
    const e = flipEffect(plan, plugin, "fx-intro", 0);
    const params = (e.params as { params: Record<string, unknown> }).params;
    expect(e).toMatchObject({ kind: "scene3d", start: 0, end: plan.duration, pluginId: "flip-hash" });
    expect([...(params.imageIds as string[])].slice(0, 3).sort()).toEqual(["a", "b", "c"]);
    expect((params.imageIds as string[])[3]).toBe("logo");
    expect(params.icon).toBe(3);
    const pages = params.pages as { t: number; img: number }[];
    expect(pages).toHaveLength(plan.pageImages.length);
    expect(pages.map((p) => (params.imageIds as string[])[p.img])).toEqual(plan.pageImages);
    expect(params).toMatchObject({ title: "My Talk", subtitle: "part 1", reveal: plan.reveal, tone: "duotone" });
  });
});

describe("insertIntro：插進時間軸", () => {
  const base = () => {
    const p = makeProject();
    p.tracks.push({ id: "A3", kind: "audio", index: 2, role: "sfx", muted: false, locked: false, volume: 1 });
    p.media.push({ id: "black", kind: "image", duration: 5 }, { id: "flip-wav", kind: "audio", duration: 0.32, audio: true }, { id: "music", kind: "audio", duration: 8, audio: true });
    return p;
  };

  it("V1 開頭放佔位素材、原本的片段往後移；特效、音效、配樂都放好；插件登記一次", () => {
    const p = base();
    const before = p.clips.map((c) => ({ id: c.id, start: c.start }));
    const sfxTrack = p.tracks.find((t) => t.role === "sfx")!.id;
    const musicTrack = p.tracks.find((t) => t.role === "music")!.id;
    const effect = flipEffect(plan, plugin, "fx-intro", 0);
    const next = insertIntro(p, {
      effect, plugin, placeholderId: "black", duration: plan.duration,
      sounds: [{ mediaId: "flip-wav", t: 0.9, volume: 1 }, { mediaId: "flip-wav", t: 1.16, volume: 0.8 }],
      music: { mediaId: "music", srcIn: 0, volume: 0.7 },
    });
    for (const b of before) expect(next.clips.find((c) => c.id === b.id)!.start).toBeCloseTo(b.start + plan.duration, 6);
    const v1 = next.tracks.find((t) => t.kind === "video" && t.index === 0)!.id;
    expect(next.clips.find((c) => c.trackId === v1 && c.mediaId === "black")).toMatchObject({ start: 0, srcIn: 0, srcOut: plan.duration });
    expect(next.effects.find((e) => e.id === "fx-intro")).toMatchObject({ start: 0, end: plan.duration });
    expect(next.plugins.filter((x) => x.hash === "flip-hash")).toHaveLength(1);
    const sfx = next.clips.filter((c) => c.trackId === sfxTrack && c.mediaId === "flip-wav");
    expect(sfx.map((c) => [c.start, c.volume, c.srcOut])).toEqual([[0.9, 1, 0.32], [1.16, 0.8, 0.32]]);
    // 配樂：到片頭結尾為止，結尾淡出
    expect(next.clips.find((c) => c.trackId === musicTrack && c.mediaId === "music")).toMatchObject({ start: 0, srcIn: 0, srcOut: plan.duration, volume: 0.7 });
    // 再插一次，插件不重複
    const again = insertIntro(next, { effect: { ...effect, id: "fx-2" }, plugin, placeholderId: "black", duration: plan.duration, sounds: [] });
    expect(again.plugins.filter((x) => x.hash === "flip-hash")).toHaveLength(1);
  });

  it("透過 history 是一次編輯（Ctrl+Z 一次復原）", () => {
    const p = base();
    const effect = flipEffect(plan, plugin, "fx-intro", 0);
    const next = applyEdits(p, [{ kind: "insertIntro", intro: { effect, plugin, placeholderId: "black", duration: plan.duration, sounds: [] } }]);
    expect(next.effects).toHaveLength(p.effects.length + 1);
  });

  it("音效軌鎖住就不放音效，其他照放", () => {
    const p = base();
    p.tracks = p.tracks.map((t) => (t.role === "sfx" ? { ...t, locked: true } : t));
    const next = insertIntro(p, { effect: flipEffect(plan, plugin, "fx", 0), plugin, placeholderId: "black", duration: plan.duration, sounds: [{ mediaId: "flip-wav", t: 1, volume: 1 }] });
    expect(next.clips.some((c) => c.mediaId === "flip-wav")).toBe(false);
    expect(next.effects.some((e) => e.id === "fx")).toBe(true);
  });
});
