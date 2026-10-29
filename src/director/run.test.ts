import { describe, expect, it } from "vitest";
import type { Media, Word } from "../core/model";
import type { Activity } from "./activity";
import type { DirectorSuggestion, DirectorView } from "./api";
import { runDirector } from "./run";

// AI 導演的一次執行（docs/plan-10-29-director2.md；不連網）：切段 → 每段算畫面變化區、轉小檔、連同詞上傳 → 規劃完（planned）→
// 依各項時間拼縮圖總表送審 → 審查完（done）→ 剪輯腳本（補 id、素材、狀態；審查刪掉的是略過；放大帶活動區的路徑）＋章節。
const media: Media = { id: "m1", name: "talk.mp4", kind: "video", duration: 300, width: 1920, height: 1080, audio: true };
const words: Word[] = Array.from({ length: 500 }, (_, i) => ({ id: `m1:w${i}`, mediaId: "m1", text: `w${i}`, start: i * 0.6, end: i * 0.6 + 0.4 }));

/** 閘道回的一項 */
const item = (id: string, kind: DirectorSuggestion["kind"], start: number, end: number, payload: Record<string, unknown> = {}, review?: DirectorSuggestion["review"]): DirectorSuggestion =>
  ({ id, kind, start, end, reason: "r", purpose: `purpose ${id}`, quote: `quote ${id}`, chapter: 0, payload, review: review ?? null });

/** 假閘道：collecting 兩次 → planned → 收到審查後 reviewing → done */
function fakeApi(final: Partial<DirectorView> = {}) {
  const calls: { kind: string; index?: number; activities?: number; sheet?: boolean }[] = [];
  let polls = 0;
  let reviewed = false;
  const base = { segmentsDone: 3, segmentsTotal: 3, segmentsFailed: 0, error: null, chapters: [{ title: "Setup", start: 0, end: 150 }, { title: "Code", start: 150, end: 300 }], removed: [] };
  return {
    calls,
    api: {
      async start(body: { segments: number; scenes: { id: string }[] }) { calls.push({ kind: `start:${body.segments}:${body.scenes.length}` }); return "d1"; },
      async upload(_id: string, index: number, meta: { activities?: unknown[] }) { calls.push({ kind: "upload", index, activities: meta.activities?.length ?? 0 }); },
      async review(_id: string, sheet: Blob | null) { reviewed = true; calls.push({ kind: "review", sheet: !!sheet }); },
      async poll(): Promise<DirectorView> {
        polls++;
        if (polls < 3) return { ...base, status: "collecting", segmentsDone: polls - 1, suggestions: [] };
        if (!reviewed) return { ...base, status: "planned", suggestions: [item("i1", "cut", 10, 12), item("i2", "zoom", 102, 110, { activity: "a1000" }), item("i3", "effect", 200, 204, { description: "d" })] };
        return {
          ...base, status: "done",
          suggestions: [item("i1", "cut", 10, 12, {}, { verdict: "keep", note: "ok" }), item("i2", "zoom", 102, 110, { activity: "a1000" }, { verdict: "revised", note: "start at 102" })],
          removed: [item("i3", "effect", 200, 204, { description: "d" }, { verdict: "drop", note: "nothing on screen" })],
          ...final,
        };
      },
      async cancel() { calls.push({ kind: "cancel" }); },
    },
  };
}

/** 第二段（約 100 秒起）有一個打字的活動區 */
const activities = async (s: number): Promise<Activity[]> => (s >= 90 && s < 200
  ? [{ id: "a1000", start: 100, end: 112, x: 0.3, y: 0.2, w: 0.4, h: 0.3, path: [{ t: 101, cx: 0.4, cy: 0.3, w: 0.1, h: 0.05 }, { t: 108, cx: 0.45, cy: 0.4, w: 0.1, h: 0.05 }] }]
  : []);

describe("runDirector", () => {
  it("每段帶活動區上傳；規劃完拼總表送審；審查完回剪輯腳本與章節：審查刪掉的是略過、放大帶路徑", async () => {
    const { api, calls } = fakeApi();
    const stages: string[] = [];
    const sheets: string[][] = [];
    const result = await runDirector({
      media, words, scenes: [{ id: "desk-reveal", name: "Desk" }], api, pollMs: 0,
      makeClip: async () => new Uint8Array(8),
      activities,
      contactSheet: async (items) => { sheets.push(items.map((s) => s.id)); return new Blob(["x"], { type: "image/jpeg" }); },
      onProgress: (p) => stages.push(p.stage),
    });
    expect(calls.filter((c) => c.kind === "upload").map((c) => c.activities)).toEqual([0, 1, 0]);
    expect(sheets).toEqual([["i1", "i2", "i3"]]);
    expect(calls.find((c) => c.kind === "review")).toEqual({ kind: "review", sheet: true });
    expect(stages).toEqual(expect.arrayContaining(["converting", "analysing", "reviewing"]));
    expect(result.chapters.map((c) => [c.mediaId, c.title])).toEqual([["m1", "Setup"], ["m1", "Code"]]);
    const byId = Object.fromEntries(result.suggestions.map((s) => [s.id.split("-").pop(), s]));
    expect(byId.i1).toMatchObject({ kind: "cut", status: "pending", mediaId: "m1", purpose: "purpose i1", quote: "quote i1", review: { verdict: "keep", note: "ok" } });
    expect(byId.i3).toMatchObject({ kind: "effect", status: "skipped", review: { verdict: "drop", note: "nothing on screen" } });
    const zoomPath = byId.i2.payload.path as { src: number }[];
    expect(zoomPath.length).toBeGreaterThan(0);
    expect(byId.i2.payload.w).toBeGreaterThan(0.25);
    expect(result.suggestions.map((s) => s.start)).toEqual([...result.suggestions.map((s) => s.start)].sort((a, b) => a - b));
  });

  it("取消：通知閘道、丟 AbortError；閘道回失敗：丟給使用者看的訊息；沒有總表也能審查", async () => {
    const ctrl = new AbortController();
    const { api, calls } = fakeApi();
    const slow = { ...api, async poll() { ctrl.abort(); return api.poll(); } };
    await expect(runDirector({ media, words, scenes: [], api: slow, pollMs: 0, signal: ctrl.signal, makeClip: async () => new Uint8Array(8) })).rejects.toThrow(/abort|cancel/i);
    expect(calls.some((c) => c.kind === "cancel")).toBe(true);
    const failing = fakeApi();
    const failApi = { ...failing.api, async poll(): Promise<DirectorView> { return { status: "failed", segmentsDone: 0, segmentsTotal: 3, segmentsFailed: 3, chapters: [], suggestions: [], removed: [], error: "segments-failed" }; } };
    await expect(runDirector({ media, words, scenes: [], api: failApi, pollMs: 0, makeClip: async () => new Uint8Array(8) })).rejects.toThrow(/couldn't/i);
    const plain = fakeApi();
    await runDirector({ media, words, scenes: [], api: plain.api, pollMs: 0, makeClip: async () => new Uint8Array(8) });
    expect(plain.calls.find((c) => c.kind === "review")).toEqual({ kind: "review", sheet: false });
  });
});
