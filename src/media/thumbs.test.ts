import { describe, expect, it } from "vitest";
import { CHUNK, TIERS, chunkCount, indicesInChunk, nextJob, pickThumb, type DoneMap } from "./thumbs";

// 漸進式縮圖（D39，開發者 2026-10-28）：三層（每 10 秒寬 160 → 每 2 秒寬 320 → 每 0.5 秒寬 480），每層以 60 秒為一段產生
describe("縮圖分層與分段", () => {
  it("三層的間隔與寬度；每段 60 秒（三種間隔都整除，索引一律是整數）", () => {
    expect(TIERS).toEqual([{ interval: 10, width: 160 }, { interval: 2, width: 320 }, { interval: 0.5, width: 480 }]);
    expect(CHUNK).toBe(60);
    for (const t of TIERS) expect(Number.isInteger(CHUNK / t.interval)).toBe(true);
  });

  it("段數：不足一段也算一段", () => {
    expect(chunkCount(4)).toBe(1);
    expect(chunkCount(60)).toBe(1);
    expect(chunkCount(60.1)).toBe(2);
    expect(chunkCount(0)).toBe(1);
  });

  it("一段裡的索引：時間 = 索引 × 間隔，不超過片長", () => {
    expect(indicesInChunk(0, 0, 4)).toEqual([0]);
    expect(indicesInChunk(1, 0, 4)).toEqual([0, 1]);
    expect(indicesInChunk(2, 0, 4)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(indicesInChunk(0, 1, 130)).toEqual([6, 7, 8, 9, 10, 11]);
    expect(indicesInChunk(0, 2, 130)).toEqual([12]);
    expect(indicesInChunk(0, 2, 131)).toEqual([12, 13]);
  });
});

describe("pickThumb：用做好的最細一層，取最近的一張", () => {
  const none: DoneMap = [[], [], []];
  it("都沒做好：null", () => {
    expect(pickThumb(none, 130, 5)).toBeNull();
  });

  it("只有第一層：取最近的 10 秒點", () => {
    expect(pickThumb([[0, 1, 2], [], []], 130, 14)).toEqual({ tier: 0, index: 1, time: 10 });
    expect(pickThumb([[0, 1, 2], [], []], 130, 16)).toEqual({ tier: 0, index: 2, time: 20 });
  });

  it("那一段的細層做好了就用細層；其他段沒做好的退回粗層", () => {
    const done: DoneMap = [[0, 1, 2], [0], [1]];
    expect(pickThumb(done, 130, 3.1)).toEqual({ tier: 1, index: 2, time: 4 });
    expect(pickThumb(done, 130, 70.2)).toEqual({ tier: 2, index: 140, time: 70 });
    expect(pickThumb(done, 130, 125)).toEqual({ tier: 0, index: 12, time: 120 });
  });

  it("四捨五入會跑到還沒做好的下一段時，退回這一段的最後一張；不超過片長", () => {
    expect(pickThumb([[0], [0], []], 130, 59.5)).toEqual({ tier: 1, index: 29, time: 58 });
    expect(pickThumb([[0, 1, 2], [], []], 125, 124.9)).toEqual({ tier: 0, index: 12, time: 120 });
  });
});

describe("nextJob：先把所有素材的粗層做完，再做細層", () => {
  it("依層、素材、段的順序；minTier 以下的跳過", () => {
    const items = [
      { mediaId: "a", duration: 130, done: [[0, 1, 2], [0], []] as DoneMap },
      { mediaId: "b", duration: 30, done: [[], [], []] as DoneMap },
    ];
    expect(nextJob(items)).toEqual({ mediaId: "b", tier: 0, chunk: 0 });
    items[1].done[0] = [0];
    expect(nextJob(items)).toEqual({ mediaId: "a", tier: 1, chunk: 1 });
    items[0].done[1] = [0, 1, 2];
    items[1].done[1] = [0];
    expect(nextJob(items)).toEqual({ mediaId: "a", tier: 2, chunk: 0 });
    expect(nextJob(items, 0, 1)).toBeNull();
  });
});
