import { describe, expect, it } from "vitest";
import { MAX_CHUNK_SECONDS, clipSize, estimateUsd, planChunks } from "./plan";

// SAM 請求的規劃（docs/plan-10-28-sam.md）：小檔尺寸（寬 ≤ 上限、偶數、不放大）、長範圍切成多段（相鄰重疊一格好接續）、估價。
describe("clipSize", () => {
  it("寬度不超過上限、取偶數、等比例；原片較小不放大", () => {
    expect(clipSize(1920, 1080, 1280)).toEqual({ width: 1280, height: 720 });
    expect(clipSize(1366, 768, 1280)).toEqual({ width: 1280, height: 720 });
    expect(clipSize(320, 180, 1280)).toEqual({ width: 320, height: 180 });
    expect(clipSize(1001, 563, 1280)).toEqual({ width: 1000, height: 562 });
  });
});

describe("planChunks", () => {
  it("90 秒內一段；更長的切開，下一段從上一段最後一格開始（重疊一格）", () => {
    expect(planChunks(10, 40, 10)).toEqual([{ start: 10, end: 40 }]);
    const chunks = planChunks(0, 200, 10);
    expect(chunks[0]).toEqual({ start: 0, end: MAX_CHUNK_SECONDS });
    expect(chunks[1].start).toBeCloseTo(MAX_CHUNK_SECONDS - 0.1, 6);
    expect(chunks[chunks.length - 1].end).toBe(200);
    for (const c of chunks) expect(c.end - c.start).toBeLessThanOrEqual(MAX_CHUNK_SECONDS + 1e-9);
  });
});

describe("estimateUsd", () => {
  it("每千格 US$0.20，每次請求至少算 50 格（2026-10-28 實測 40 格記 50）", () => {
    expect(estimateUsd([40])).toBeCloseTo(0.01, 6);
    expect(estimateUsd([100, 900])).toBeCloseTo(0.2, 6);
  });
});
