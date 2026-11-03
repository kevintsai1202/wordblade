import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeWav, parseWav } from "../asr/wav";
import { makeProject } from "../core/fixtures";
import type { Media, Word } from "../core/model";
import { buildSeed, clearSeedCache, dialogueMedia, fitToRange, pickSeedSpans, rangeText, spanText, speechSpans } from "./revoice";

/** 一個詞 */
const w = (id: string, start: number, end: number, text = id, mediaId = "m1"): Word => ({ id, mediaId, text, start, end });

describe("speechSpans／pickSeedSpans", () => {
  it("詞與詞空隙不超過 0.6 秒接成一段，超過就分段", () => {
    const spans = speechSpans([w("a", 0, 1), w("b", 1.3, 2), w("c", 3, 4)]);
    expect(spans).toEqual([{ start: 0, end: 2 }, { start: 3, end: 4 }]);
  });

  it("由長到短挑到 60 秒為止，回傳依時間排序", () => {
    const spans = [{ start: 0, end: 10 }, { start: 20, end: 50 }, { start: 60, end: 85 }, { start: 100, end: 105 }];
    // 長度 10、30、25、5：先 30、再 25、再 10 湊到 65 >= 60，不再取 5
    expect(pickSeedSpans(spans)).toEqual([{ start: 0, end: 10 }, { start: 20, end: 50 }, { start: 60, end: 85 }]);
  });

  it("單段超過額度時截到 90 秒的剩餘額度", () => {
    expect(pickSeedSpans([{ start: 0, end: 200 }])).toEqual([{ start: 0, end: 90 }]);
    // 先取最長的 70 秒，再來 50 秒那段只剩 20 秒額度（90 減 70）
    expect(pickSeedSpans([{ start: 0, end: 50 }, { start: 100, end: 170 }], { target: 100 })).toEqual([{ start: 0, end: 20 }, { start: 100, end: 170 }]);
  });

  it("總長不到最少 20 秒回 null", () => {
    expect(pickSeedSpans([{ start: 0, end: 10 }, { start: 20, end: 29 }])).toBeNull();
    expect(pickSeedSpans([{ start: 0, end: 10 }, { start: 20, end: 30 }])).not.toBeNull();
  });

  it("spanText 只取中點在區段內的詞", () => {
    const words = [w("a", 0, 1, "one"), w("b", 1, 2, "two"), w("c", 2, 3, "three")];
    expect(spanText(words, { start: 0, end: 2.4 })).toBe("one two");
  });
});

describe("buildSeed", () => {
  beforeEach(() => clearSeedCache());
  const media: Media = { id: "m1", kind: "video", duration: 100, audio: true };
  /** 每 5 秒一句、句間空 1 秒，共 8 句（40 秒的話） */
  const words = Array.from({ length: 8 }, (_, i) => w(`w${i}`, i * 6, i * 6 + 5, `s${i}`));

  it("逐段抽音訊接成一個 WAV，文字是這些區段的詞；同素材第二次用快取", async () => {
    const extract = vi.fn(async (_m: Media, s: number, e: number) => encodeWav(new Float32Array(Math.round((e - s) * 16000)).fill(0.1), 16000));
    const seed = await buildSeed(media, words, extract);
    expect(extract).toHaveBeenCalledTimes(8);
    expect(seed.seconds).toBeCloseTo(40, 1);
    expect(parseWav(seed.wav).rate).toBe(16000);
    expect(seed.text).toBe("s0 s1 s2 s3 s4 s5 s6 s7");
    await buildSeed(media, words, extract);
    expect(extract).toHaveBeenCalledTimes(8);
  });

  it("說話不到 20 秒丟錯，不去抽音訊", async () => {
    const extract = vi.fn();
    await expect(buildSeed(media, words.slice(0, 3), extract)).rejects.toThrow("Need at least 20 seconds of transcribed speech");
    expect(extract).not.toHaveBeenCalled();
  });
});

describe("dialogueMedia／rangeText", () => {
  it("取對白軌用得最久的素材；沒有對白片段就退回 V1", () => {
    const p = makeProject();
    expect(dialogueMedia(p)?.id).toBe("m1");
    p.clips = p.clips.filter((c) => c.trackId !== "A1");
    expect(dialogueMedia(p)?.id).toBe("m1");
    p.clips = [];
    expect(dialogueMedia(p)).toBeNull();
  });

  it("範圍內的逐字稿接成預設文字", () => {
    const p = makeProject();
    expect(rangeText(p, { start: 0.5, end: 3.2 })).toBe("hello um world");
    expect(rangeText(p, { start: 1.9, end: 3.2 })).toBe("world");
    expect(rangeText(p, { start: 5, end: 8 })).toBe("");
  });
});

describe("fitToRange", () => {
  const mk = (...secs: number[]) => {
    const calls: number[] = [];
    return { calls, speak: async (speed: number) => { calls.push(speed); return { audio: new Uint8Array(1), seconds: secs[Math.min(calls.length - 1, secs.length - 1)] }; } };
  };

  it("不超過範圍（含 0.05 容許）：只念一次，不變速", async () => {
    const t = mk(2.04);
    expect(await fitToRange(t.speak, 2)).toMatchObject({ seconds: 2.04, clipSpeed: 1 });
    expect(t.calls).toEqual([1]);
  });

  it("太長：以加快語速重念（上限 1.3、多 2%），夠短就不用變速", async () => {
    const t = mk(2.5, 1.98);
    expect(await fitToRange(t.speak, 2)).toMatchObject({ seconds: 1.98, clipSpeed: 1 });
    expect(t.calls[0]).toBe(1);
    expect(t.calls[1]).toBeCloseTo(1.275, 3);
  });

  it("還是太長：片段倍速等於念出長度除以範圍（上限 4）", async () => {
    const t = mk(5, 3);
    const r = await fitToRange(t.speak, 2);
    expect(t.calls[1]).toBe(1.3);
    expect(r.clipSpeed).toBeCloseTo(1.5, 5);
    expect((await fitToRange(mk(100, 50).speak, 2)).clipSpeed).toBe(4);
  });
});
