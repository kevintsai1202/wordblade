import { describe, expect, it } from "vitest";
import { commit, createHistory, undo } from "./history";
import { makeProject } from "./fixtures";
import { audioSourceFor, sourceOfVocals } from "./stems";
import type { Project } from "./model";

/** 測試專案加上 m1 的人聲與背景兩支素材 */
function withStemMedia(): Project {
  const p = makeProject();
  return { ...p, media: [...p.media, { id: "m1v", kind: "audio", duration: 600 }, { id: "m1b", kind: "audio", duration: 600 }] };
}

// 聲音分離（§5.14）：原素材在音軌上的片段換成人聲（原軌）＋背景（新增 music 軌），影像片段不動，一次復原
describe("separateStems", () => {
  it("對白軌上 m1 的片段換成人聲＋背景，位置與修邊相同；影片片段不動", () => {
    const p = withStemMedia();
    const h = commit(createHistory(p), [{ kind: "separateStems", mediaId: "m1", vocalsId: "m1v", backgroundId: "m1b" }]);
    const q = h.present;
    // V1 的 m1 影片片段維持
    expect(q.clips.filter((c) => c.mediaId === "m1" && c.trackId === "V1")).toHaveLength(2);
    // A1 上 m1 的片段沒了，換成 m1v（原軌）
    expect(q.clips.some((c) => c.mediaId === "m1" && c.trackId === "A1")).toBe(false);
    const vocals = q.clips.filter((c) => c.mediaId === "m1v");
    expect(vocals.map((c) => [c.trackId, c.start, c.srcIn, c.srcOut, c.speed])).toEqual([["A1", 0, 0, 10, 1], ["A1", 10, 20, 30, 1]]);
    // 背景在新增的 music 軌，同樣的位置與修邊
    const newTrack = q.tracks.find((t) => !p.tracks.some((o) => o.id === t.id))!;
    expect(newTrack).toMatchObject({ kind: "audio", role: "music", muted: false, locked: false });
    const bg = q.clips.filter((c) => c.mediaId === "m1b");
    expect(bg.map((c) => [c.trackId, c.start, c.srcIn, c.srcOut, c.speed])).toEqual([[newTrack.id, 0, 0, 10, 1], [newTrack.id, 10, 20, 30, 1]]);
    // 其他素材的片段不動；原素材記下 stems
    expect(q.clips.find((c) => c.id === "a1c")).toEqual(p.clips.find((c) => c.id === "a1c"));
    expect(q.media.find((m) => m.id === "m1")!.stems).toEqual({ vocalsId: "m1v", backgroundId: "m1b" });
    expect(q.stems).toEqual([{ mediaId: "m1", vocalsId: "m1v", backgroundId: "m1b", model: "Kim_Vocal_2" }]);
    // 一次 Ctrl+Z 全部回來
    expect(undo(h).present).toEqual(p);
  });

  it("保留片段的音量、淡入淡出與變速", () => {
    const p = withStemMedia();
    p.clips = p.clips.map((c) => (c.id === "a1a" ? { ...c, volume: 0.5, fadeIn: 0.2, speed: 1.25 } : c));
    const q = commit(createHistory(p), [{ kind: "separateStems", mediaId: "m1", vocalsId: "m1v", backgroundId: "m1b" }]).present;
    for (const id of ["m1v", "m1b"]) expect(q.clips.find((c) => c.mediaId === id && c.start === 0)).toMatchObject({ volume: 0.5, fadeIn: 0.2, speed: 1.25 });
  });

  it("鎖定的音軌不動；衍生素材不在專案裡時原樣回傳", () => {
    const p = withStemMedia();
    p.tracks = p.tracks.map((t) => (t.id === "A1" ? { ...t, locked: true } : t));
    const q = commit(createHistory(p), [{ kind: "separateStems", mediaId: "m1", vocalsId: "m1v", backgroundId: "m1b" }]).present;
    expect(q.clips.filter((c) => c.mediaId === "m1" && c.trackId === "A1")).toHaveLength(2);
    expect(q.tracks).toHaveLength(p.tracks.length);
    expect(q.media.find((m) => m.id === "m1")!.stems).toBeDefined();
    const h = createHistory(makeProject());
    expect(commit(h, [{ kind: "separateStems", mediaId: "m1", vocalsId: "nope", backgroundId: "nope2" }])).toBe(h);
  });

  it("沒有放上時間軸的素材只記 stems，不建新軌", () => {
    const p = withStemMedia();
    p.clips = p.clips.filter((c) => c.mediaId !== "m1");
    const q = commit(createHistory(p), [{ kind: "separateStems", mediaId: "m1", vocalsId: "m1v", backgroundId: "m1b" }]).present;
    expect(q.tracks).toHaveLength(p.tracks.length);
    expect(q.media.find((m) => m.id === "m1")!.stems).toEqual({ vocalsId: "m1v", backgroundId: "m1b" });
  });

  it("純音訊素材（只在音軌上）也一樣換", () => {
    const q = commit(createHistory(withStemMedia()), [{ kind: "separateStems", mediaId: "mus", vocalsId: "m1v", backgroundId: "m1b" }]).present;
    expect(q.clips.some((c) => c.mediaId === "mus")).toBe(false);
    expect(q.clips.find((c) => c.mediaId === "m1v")).toMatchObject({ trackId: "A2", start: 0, srcOut: 30 });
  });
});

// 其他功能用人聲：ASR 與重配音取樣從人聲抽音訊，逐字稿仍記在原素材
describe("audioSourceFor / sourceOfVocals", () => {
  it("有 stems 用人聲，否則用自己；離線的人聲不用", () => {
    const p = commit(createHistory(withStemMedia()), [{ kind: "separateStems", mediaId: "m1", vocalsId: "m1v", backgroundId: "m1b" }]).present;
    const m1 = p.media.find((m) => m.id === "m1")!;
    expect(audioSourceFor(p, m1).id).toBe("m1v");
    expect(audioSourceFor(p, p.media.find((m) => m.id === "m2")!).id).toBe("m2");
    const off = { ...p, media: p.media.map((m) => (m.id === "m1v" ? { ...m, offline: true } : m)) };
    expect(audioSourceFor(off, off.media.find((m) => m.id === "m1")!).id).toBe("m1");
    expect(sourceOfVocals(p, p.media.find((m) => m.id === "m1v")!).id).toBe("m1");
    expect(sourceOfVocals(p, m1).id).toBe("m1");
  });
});
