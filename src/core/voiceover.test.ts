import { describe, expect, it } from "vitest";
import { makeProject } from "./fixtures";
import { canUndo, commit, createHistory, undo } from "./history";
import type { Project } from "./model";
import { activeVoiceoverRanges, addVoiceover, deleteVoiceover, isMutedAt, muteFactor, mutedRangesFor, setVoiceoverActive } from "./voiceover";

/** 專案多一支 6 秒的 AI 聲音素材 */
function withVoiceMedia(): Project {
  const p = makeProject();
  return { ...p, media: [...p.media, { id: "vo1", kind: "audio", duration: 6 }] };
}
const NEW = { id: "vo-a", start: 3, end: 6, text: "hello there", mediaId: "vo1" };

describe("addVoiceover", () => {
  it("沒有 Voice 軌就在所有音軌最後建一條，片段放在範圍起點，記下一筆重配音", () => {
    const p = addVoiceover(withVoiceMedia(), NEW);
    const track = p.tracks.find((t) => t.role === "voice")!;
    expect(track).toMatchObject({ kind: "audio", index: 2, id: "A3" });
    const clip = p.clips.find((c) => c.trackId === track.id)!;
    expect(clip).toMatchObject({ mediaId: "vo1", start: 3, srcIn: 0, srcOut: 6, speed: 1 });
    expect(p.voiceovers).toEqual([{ ...NEW, clipId: clip.id, active: true }]);
  });

  it("已有 Voice 軌就沿用（不再建第二條）", () => {
    const once = addVoiceover(withVoiceMedia(), NEW);
    const twice = addVoiceover(once, { ...NEW, id: "vo-b", start: 10, end: 12 });
    expect(twice.tracks.filter((t) => t.role === "voice")).toHaveLength(1);
    expect(twice.voiceovers).toHaveLength(2);
  });

  it("需要時套片段變速（保持音高：6 秒的聲音 x2 變 3 秒）", () => {
    const p = addVoiceover(withVoiceMedia(), NEW, 2);
    const clip = p.clips.find((c) => c.id === p.voiceovers![0].clipId)!;
    expect(clip.speed).toBe(2);
  });

  it("素材不在專案、Voice 軌鎖定時原樣回傳", () => {
    const base = makeProject();
    expect(addVoiceover(base, NEW)).toBe(base);
    const made = addVoiceover(withVoiceMedia(), NEW);
    const locked = { ...made, tracks: made.tracks.map((t) => (t.role === "voice" ? { ...t, locked: true } : t)) };
    expect(addVoiceover(locked, { ...NEW, id: "vo-c" })).toBe(locked);
  });

  it("一次提交、一次 Ctrl+Z 全部復原（軌道、片段、紀錄）", () => {
    const start = withVoiceMedia();
    let h = commit(createHistory(start), [{ kind: "addVoiceover", voiceover: NEW, speed: 1.5 }]);
    expect(h.past).toHaveLength(1);
    expect(h.present.voiceovers).toHaveLength(1);
    h = undo(h);
    expect(h.present).toBe(start);
    expect(canUndo(h)).toBe(false);
  });
});

describe("setVoiceoverActive／deleteVoiceover", () => {
  it("切換 active；沒變或找不到回傳原物件；可復原", () => {
    const p = addVoiceover(withVoiceMedia(), NEW);
    const off = setVoiceoverActive(p, "vo-a", false);
    expect(off.voiceovers![0].active).toBe(false);
    expect(setVoiceoverActive(off, "vo-a", false)).toBe(off);
    expect(setVoiceoverActive(p, "nope", false)).toBe(p);
    const h = commit(createHistory(p), [{ kind: "setVoiceoverActive", id: "vo-a", active: false }]);
    expect(undo(h).present).toBe(p);
  });

  it("刪除：片段與紀錄一起拿掉（軌道與素材留著），一次復原", () => {
    const p = addVoiceover(withVoiceMedia(), NEW);
    const clipId = p.voiceovers![0].clipId;
    const gone = deleteVoiceover(p, "vo-a");
    expect(gone.voiceovers).toEqual([]);
    expect(gone.clips.some((c) => c.id === clipId)).toBe(false);
    expect(gone.tracks.some((t) => t.role === "voice")).toBe(true);
    expect(gone.media.some((m) => m.id === "vo1")).toBe(true);
    expect(deleteVoiceover(p, "nope")).toBe(p);
    expect(undo(commit(createHistory(p), [{ kind: "deleteVoiceover", id: "vo-a" }])).present).toBe(p);
  });
});

describe("靜音規則", () => {
  const base = addVoiceover(withVoiceMedia(), NEW);
  const clipOf = (p: Project, id: string) => p.clips.find((c) => c.id === id)!;
  const trackOf = (p: Project, id: string) => p.tracks.find((t) => t.id === clipOf(p, id).trackId);

  it("生效中：對白軌的片段在範圍內靜音，配樂與 AI 片段不受影響", () => {
    expect(activeVoiceoverRanges(base)).toEqual([{ from: 3, to: 6 }]);
    expect(mutedRangesFor(base, clipOf(base, "a1a"), trackOf(base, "a1a"))).toEqual([{ from: 3, to: 6 }]);
    expect(mutedRangesFor(base, clipOf(base, "a2"), trackOf(base, "a2"))).toEqual([]);
    const vc = base.voiceovers![0].clipId;
    expect(mutedRangesFor(base, clipOf(base, vc), trackOf(base, vc))).toEqual([]);
  });

  it("切回原音：對白不靜音，AI 片段整段靜音", () => {
    const off = setVoiceoverActive(base, "vo-a", false);
    expect(activeVoiceoverRanges(off)).toEqual([]);
    expect(mutedRangesFor(off, clipOf(off, "a1a"), trackOf(off, "a1a"))).toEqual([]);
    const vc = off.voiceovers![0].clipId;
    expect(mutedRangesFor(off, clipOf(off, vc), trackOf(off, vc))).toEqual([{ from: 3, to: 9 }]);
  });

  it("AI 片段被手動刪掉後，這筆重配音不再讓對白靜音", () => {
    const orphan = { ...base, clips: base.clips.filter((c) => c.id !== base.voiceovers![0].clipId) };
    expect(activeVoiceoverRanges(orphan)).toEqual([]);
  });

  it("isMutedAt：起點含、終點不含", () => {
    const r = [{ from: 3, to: 6 }];
    expect([2.99, 3, 5.99, 6].map((t) => isMutedAt(r, t))).toEqual([false, true, true, false]);
  });

  it("muteFactor：範圍內 0，範圍外 10 ms 內線性回到 1", () => {
    const r = [{ from: 3, to: 6 }];
    expect(muteFactor(r, 4)).toBe(0);
    expect(muteFactor(r, 2.995)).toBeCloseTo(0.5, 5);
    expect(muteFactor(r, 6.005)).toBeCloseTo(0.5, 5);
    expect(muteFactor(r, 2.9)).toBe(1);
    expect(muteFactor(r, 7)).toBe(1);
  });
});

// 前面剪掉一段（漣漪）後，AI 片段往前移，靜音範圍要跟著片段走，不能停在記錄的舊時間
describe("靜音範圍跟著 AI 片段", () => {
  it("片段移到別處，範圍就是片段的新位置", () => {
    const base = makeProject();
    base.media = [...base.media, { id: "vo", kind: "audio", duration: 2, audio: true }];
    const p = addVoiceover(base, { id: "v1", start: 10, end: 12, text: "hi", mediaId: "vo" });
    const clipId = p.voiceovers![0].clipId;
    const moved = { ...p, clips: p.clips.map((c) => (c.id === clipId ? { ...c, start: 4 } : c)) };
    expect(activeVoiceoverRanges(moved)).toEqual([{ from: 4, to: 6 }]);
    // 長度是框選範圍（2 秒），不是 AI 片段的長度
  });
});
