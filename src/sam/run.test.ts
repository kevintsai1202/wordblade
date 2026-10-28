import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runSam } from "./run";
import type { SamClip } from "./clip";
import type { SamJobView } from "./api";
import { sseDeltas } from "./stream";

// 遮罩流程（不連網）：分段 → 轉小檔（假的）→ 閘道工作（假的，重播 2026-10-28 實測串流）→ 逐格解析 → 物件；取消時通知閘道。
const LINES = sseDeltas(readFileSync(path.join(import.meta.dirname, "fixtures", "fosdem-person.sse"), "utf8")).join("").split("\n").filter(Boolean);

/** 假的小檔：每秒 10 格 */
const fakeClip = async (s: number, e: number): Promise<SamClip> => {
  const n = Math.round((e - s) * 10);
  return { bytes: new Uint8Array(4), width: 1280, height: 720, times: Array.from({ length: n }, (_, k) => Math.round((s + k / 10) * 1e6) / 1e6), diffs: Array(n).fill(1) };
};

/** 假的閘道：每次輪詢給 15 行，給完就 done */
function fakeApi() {
  const calls: string[] = [];
  const jobs = new Map<string, number>();
  return {
    calls,
    api: {
      async start(prompt: string) { const id = `j${jobs.size}`; jobs.set(id, 0); calls.push(`start:${prompt}`); return id; },
      async poll(_id: string, after: number): Promise<SamJobView> {
        const lines = LINES.slice(after, after + 15);
        const next = after + lines.length;
        return { status: next >= LINES.length ? "done" : "running", lines, next, framesProcessed: next >= LINES.length ? 50 : 0, error: null };
      },
      async cancel(id: string) { calls.push(`cancel:${id}`); },
    },
  };
}

describe("runSam", () => {
  it("一段：40 格的講者 → 1 個物件，時間是素材時間；回報計費格數", async () => {
    const { api, calls } = fakeApi();
    const progress: string[] = [];
    const result = await runSam({ mediaId: "m", prompt: "person", start: 30, end: 34, fps: 10, makeClip: fakeClip, api, pollMs: 0, onProgress: (p) => progress.push(p.stage) });
    expect(calls).toEqual(["start:person"]);
    expect(result.objects).toHaveLength(1);
    expect(result.objects[0].samples[0].t).toBe(30);
    expect(result.objects[0].samples).toHaveLength(40);
    expect(result.objects[0].label).toBe("person 1");
    expect(result.billedFrames).toBe(50);
    expect(result.capped).toBe(false);
    expect(progress).toContain("tracking");
  });

  it("取消：通知閘道取消、丟 AbortError", async () => {
    const { api, calls } = fakeApi();
    const ctrl = new AbortController();
    const slow = { ...api, async poll(id: string, after: number) { ctrl.abort(); return api.poll(id, after); } };
    await expect(runSam({ mediaId: "m", prompt: "person", start: 30, end: 34, fps: 10, makeClip: fakeClip, api: slow, pollMs: 0, signal: ctrl.signal })).rejects.toThrow(/abort|cancel/i);
    expect(calls).toContain("cancel:j0");
  });

  it("閘道回失敗：丟出給使用者看的訊息", async () => {
    const { api } = fakeApi();
    const failing = { ...api, async poll(): Promise<SamJobView> { return { status: "failed", lines: [], next: 0, framesProcessed: 0, error: "sam-upload" }; } };
    await expect(runSam({ mediaId: "m", prompt: "person", start: 0, end: 4, fps: 10, makeClip: fakeClip, api: failing, pollMs: 0 })).rejects.toThrow(/upload/i);
  });
});
