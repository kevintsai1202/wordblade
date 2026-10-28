import { describe, expect, it } from "vitest";
import type { Media, Word } from "../core/model";
import type { DirectorView } from "./api";
import { runDirector } from "./run";

// AI 導演的一次執行（不連網）：切段 → 每段轉小檔（假的）＋那段的詞 → 建工作、逐段上傳 → 輪詢到完成 → 建議（前端補 id、素材、狀態，再檢查一次）。
const media: Media = { id: "m1", name: "talk.mp4", kind: "video", duration: 300, width: 1920, height: 1080, audio: true };
const words: Word[] = Array.from({ length: 500 }, (_, i) => ({ id: `m1:w${i}`, mediaId: "m1", text: `w${i}`, start: i * 0.6, end: i * 0.6 + 0.4 }));

/** 假閘道：記錄上傳的段與詞；輪詢兩次 collecting 後 done */
function fakeApi(view: Partial<DirectorView> = {}) {
  const calls: { kind: string; index?: number; words?: number; start?: number }[] = [];
  let polls = 0;
  return {
    calls,
    api: {
      async start(body: { segments: number; scenes: { id: string }[] }) { calls.push({ kind: `start:${body.segments}:${body.scenes.length}` }); return "d1"; },
      async upload(_id: string, index: number, meta: { start: number; words: unknown[] }) { calls.push({ kind: "upload", index, words: meta.words.length, start: meta.start }); },
      async poll(): Promise<DirectorView> {
        polls++;
        if (polls < 3) return { status: "collecting", segmentsDone: polls - 1, segmentsTotal: 3, segmentsFailed: 0, suggestions: [], error: null };
        return {
          status: "done", segmentsDone: 3, segmentsTotal: 3, segmentsFailed: 0, error: null,
          suggestions: [
            { kind: "mask", start: 31, end: 43, reason: "API key", payload: { target: "API key" } },
            { kind: "cut", start: 10, end: 12, reason: "Retake", payload: {} },
            { kind: "camera", start: 1, end: 5, reason: "Intro", payload: { scene: "moon", description: "x" } },
          ],
          ...view,
        };
      },
      async cancel() { calls.push({ kind: "cancel" }); },
    },
  };
}

describe("runDirector", () => {
  it("300 秒切三段、每段帶自己的詞上傳；完成後建議依時間排序、補 id／素材／狀態、不合格（場景不在清單）丟掉", async () => {
    const { api, calls } = fakeApi();
    const clips: string[] = [];
    const stages: string[] = [];
    const result = await runDirector({
      media, words, scenes: [{ id: "board-float", name: "Floating board" }], api, pollMs: 0,
      makeClip: async (s, e) => { clips.push(`${s}-${e}`); return new Uint8Array(8); },
      onProgress: (p) => stages.push(p.stage),
    });
    expect(calls[0].kind).toBe("start:3:1");
    const uploads = calls.filter((c) => c.kind === "upload");
    expect(uploads.map((u) => u.index)).toEqual([0, 1, 2]);
    expect(uploads[0].start).toBe(0);
    expect(uploads.reduce((n, u) => n + u.words!, 0)).toBe(500);
    expect(clips).toHaveLength(3);
    expect(result.map((s) => [s.kind, s.start])).toEqual([["cut", 10], ["mask", 31]]);
    expect(result[0]).toMatchObject({ mediaId: "m1", status: "pending" });
    expect(new Set(result.map((s) => s.id)).size).toBe(2);
    expect(stages).toContain("converting");
    expect(stages).toContain("analysing");
  });

  it("取消：通知閘道、丟 AbortError；閘道回失敗：丟給使用者看的訊息", async () => {
    const ctrl = new AbortController();
    const { api, calls } = fakeApi();
    const slow = { ...api, async poll() { ctrl.abort(); return api.poll(); } };
    await expect(runDirector({ media, words, scenes: [], api: slow, pollMs: 0, signal: ctrl.signal, makeClip: async () => new Uint8Array(8) })).rejects.toThrow(/abort|cancel/i);
    expect(calls.some((c) => c.kind === "cancel")).toBe(true);
    const failing = fakeApi({ status: "failed", error: "segments-failed" });
    await expect(runDirector({ media, words, scenes: [], api: failing.api, pollMs: 0, makeClip: async () => new Uint8Array(8) })).rejects.toThrow(/couldn't/i);
  });
});
