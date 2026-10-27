import { describe, expect, it } from "vitest";
import type { Envelope } from "../audio/envelope";
import { findFillers, findSilences, toCutRanges } from "./cleanup";
import { makeProject } from "./fixtures";
import { applyEdits } from "./history";
import { clipEnd } from "./timeline";

/** m1 的包絡：預設有聲，quiet 裡的區間（素材秒）無聲 */
function envWith(duration: number, quiet: [number, number][]): Envelope {
  const rms = new Float32Array(Math.round(duration * 100)).fill(0.1);
  for (const [a, b] of quiet) for (let i = Math.round(a * 100); i < Math.round(b * 100); i++) rms[i] = 0.001;
  return { rate: 100, rms };
}

describe("findFillers（一鍵去贅詞）", () => {
  it("找出 V1 上用到的贅詞：素材範圍是詞的前後各 0.05 秒，但不超過前後的詞", () => {
    const p = makeProject();
    const items = findFillers(p);
    expect(items).toHaveLength(1);
    const um = items[0];
    expect(um).toMatchObject({ kind: "filler", mediaId: "m1", label: "um" });
    expect(um.start).toBeCloseTo(1.55);
    expect(um.end).toBeCloseTo(2.05);
    // 時間軸位置（試聽用）
    expect(um.t).toBeCloseTo(1.55);
  });

  it("清單可以改：大小寫與標點不影響；不在 V1 上的詞不算", () => {
    const p = makeProject();
    p.words.push({ id: "w5", mediaId: "m1", text: "Hello,", start: 22.2, end: 22.6 });
    // w5 在素材 22.2 秒（v1b 用 20～30 秒）→ 在 V1 上；hello 有兩個（w1、w5）
    expect(findFillers(p, ["hello"]).map((f) => f.wordIds[0]).sort()).toEqual(["w1", "w5"]);
    p.words.push({ id: "w6", mediaId: "m1", text: "um", start: 15, end: 15.3 });
    // 素材 15 秒不在任何 V1 片段裡
    expect(findFillers(p).some((f) => f.wordIds[0] === "w6")).toBe(false);
  });
});

describe("findSilences（清除無聲片段）", () => {
  it("無聲 ≥ 1 秒：前後各留 0.15 秒；不到 1 秒的不算", () => {
    const p = makeProject();
    p.words = [];
    const env = new Map([["m1", envWith(600, [[4, 6], [7, 7.5]])]]);
    const items = findSilences(p, env);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: "silence", mediaId: "m1" });
    expect(items[0].start).toBeCloseTo(4.15, 1);
    expect(items[0].end).toBeCloseTo(5.85, 1);
  });

  it("和詞重疊就縮到詞的邊界；只看 V1 片段用到的素材範圍", () => {
    const p = makeProject();
    // 素材 0.5～3.5 秒無聲，但 w1（1.0～1.5）、w3（2.5～3.0）在裡面 → 不切到詞
    const env = new Map([["m1", envWith(600, [[0.5, 3.5], [12, 14]])]]);
    const items = findSilences(p, env, { minDuration: 0.6 });
    for (const it of items) {
      for (const w of p.words.filter((x) => x.mediaId === "m1")) expect(it.end <= w.start + 1e-9 || it.start >= w.end - 1e-9, `${it.start}-${it.end} vs ${w.text}`).toBe(true);
    }
    // 素材 12～14 秒不在 V1 上（v1a 0～10、v1b 20～30）
    expect(items.some((i) => i.start >= 11)).toBe(false);
  });
});

describe("toCutRanges＋cutRanges 編輯", () => {
  it("贅詞與無聲一起剪：重疊的合併、一筆編輯、可以復原", () => {
    const p = makeProject();
    const env = new Map([["m1", envWith(600, [[4, 6]])]]);
    const items = [...findFillers(p), ...findSilences(p, env)];
    const next = applyEdits(p, [{ kind: "cutRanges", ranges: toCutRanges(items) }]);
    const v1 = (q: typeof p) => q.clips.filter((c) => c.trackId === "V1").reduce((m, c) => Math.max(m, clipEnd(c)), 0);
    // 剪掉約 0.5（um）＋ 1.7（無聲）秒
    expect(v1(p) - v1(next)).toBeCloseTo(0.5 + 1.7, 1);
    expect(v1(p)).toBe(30);
  });

  it("重疊的範圍合併後只剪一次（不會多剪）", () => {
    const p = makeProject();
    const next = applyEdits(p, [{ kind: "cutRanges", ranges: [{ mediaId: "m1", start: 4, end: 6 }, { mediaId: "m1", start: 5, end: 7 }] }]);
    const end = next.clips.filter((c) => c.trackId === "V1").reduce((m, c) => Math.max(m, clipEnd(c)), 0);
    expect(end).toBeCloseTo(27);
  });
});
