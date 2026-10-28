import { describe, expect, it } from "vitest";
import { makeProject } from "../core/fixtures";
import { applyEdits } from "../core/history";
import type { Project, Suggestion, Word } from "../core/model";
import { clipEnd } from "../core/timeline";
import { planSegments } from "./segments";
import { activeSample } from "../sam/tracks";
import { adoptEdits, clampSuggestions, maskFromBox, maskNeedsSam, suggestionSpan } from "./suggestions";

// AI 導演的純函式（docs/plan-10-28-director.md R1）：依停頓切段、建議的時間軸範圍、各種建議採用時的編輯、前端的建議檢查。

/** 每 0.5 秒一個詞，gaps 裡的時間點之後停頓 seconds 秒 */
function words(duration: number, gaps: [number, number][] = []): Word[] {
  const out: Word[] = [];
  let t = 0;
  let i = 0;
  while (t < duration) {
    out.push({ id: `m1:w${i}`, mediaId: "m1", text: `w${i}`, start: t, end: t + 0.4 });
    i++;
    t += 0.5;
    for (const [at, pause] of gaps) if (Math.abs(t - at) < 0.25) t += pause;
  }
  return out;
}

describe("planSegments：依停頓切段（90～150 秒，盡量切在最長的停頓）", () => {
  it("短片一段", () => {
    expect(planSegments(words(100), 108)).toEqual([{ start: 0, end: 108 }]);
  });

  it("長片切在 90～150 秒之間最長的停頓中間", () => {
    const segs = planSegments(words(300, [[100, 3], [130, 1]]), 300);
    expect(segs[0].start).toBe(0);
    expect(segs[0].end).toBeGreaterThan(100);
    expect(segs[0].end).toBeLessThan(103.5);
    expect(segs[segs.length - 1].end).toBe(300);
    for (let i = 1; i < segs.length; i++) expect(segs[i].start).toBe(segs[i - 1].end);
    for (const s of segs) expect(s.end - s.start).toBeLessThanOrEqual(150 + 1e-9);
  });

  it("沒有逐字稿：每 120 秒一段", () => {
    expect(planSegments([], 300).map((s) => s.end)).toEqual([120, 240, 300]);
  });
});

/** 一條建議 */
const sug = (kind: Suggestion["kind"], start: number, end: number, payload: Record<string, unknown> = {}): Suggestion =>
  ({ id: `s-${kind}-${start}`, mediaId: "", kind, start, end, payload, reason: "r", status: "pending" });

describe("suggestionSpan：素材時間 → 時間軸範圍", () => {
  const p = makeProject();
  const v1a = p.clips.find((c) => c.id === "v1a")!;
  const s = (start: number, end: number) => ({ ...sug("effect", v1a.srcIn + start, v1a.srcIn + end), mediaId: v1a.mediaId });

  it("完整在片段裡", () => {
    expect(suggestionSpan(p, s(2, 4))).toEqual({ start: v1a.start + 2, end: v1a.start + 4 });
  });

  it("超出片段的部分夾掉；不在時間軸上（素材被剪掉）回 null", () => {
    const span = suggestionSpan(p, s(8, 20))!;
    expect(span.start).toBeCloseTo(v1a.start + 8, 6);
    expect(span.end).toBeCloseTo(clipEnd(v1a), 6);
    const cut: Project = { ...p, clips: p.clips.filter((c) => c.mediaId !== v1a.mediaId) };
    expect(suggestionSpan(cut, s(2, 4))).toBeNull();
  });
});

describe("adoptEdits：剪、改字、放大是一筆編輯，狀態一起改", () => {
  const base = makeProject();
  const v1a = base.clips.find((c) => c.id === "v1a")!;
  const media = v1a.mediaId;

  it("剪：那段素材範圍漣漪刪除，建議標成已採用（一次 Ctrl+Z 全部回來）", () => {
    const s = { ...sug("cut", v1a.srcIn + 2, v1a.srcIn + 4), mediaId: media };
    const p0 = applyEdits(base, [{ kind: "setSuggestions", mediaId: media, suggestions: [s] }]);
    const p = applyEdits(p0, adoptEdits(p0, s)!);
    // 剪掉 2 秒：V1 的總長少 2 秒（片段在切點分成兩段）
    const v1Len = (q: Project) => q.clips.filter((c) => c.trackId === v1a.trackId).reduce((n, c) => n + clipEnd(c) - c.start, 0);
    expect(v1Len(p)).toBeCloseTo(v1Len(p0) - 2, 6);
    expect(p.suggestions[0].status).toBe("applied");
  });

  it("放大：建立放大區段（建議的中心與框寬）", () => {
    const s = { ...sug("zoom", v1a.srcIn + 1, v1a.srcIn + 3, { cx: 0.3, cy: 0.4, w: 0.5 }), mediaId: media };
    const p = applyEdits(base, adoptEdits(base, s)!);
    expect(p.zooms?.[0]).toMatchObject({ mediaId: media, start: v1a.srcIn + 1, end: v1a.srcIn + 3, w: 0.5, path: [{ cx: 0.3, cy: 0.4 }] });
  });

  it("改字：換掉那幾個詞；詞已不存在就不能採用（null）", () => {
    const withWords: Project = { ...base, words: [{ id: "m:w0", mediaId: media, text: "Jav", start: 1, end: 1.4 }, { id: "m:w1", mediaId: media, text: "ah", start: 1.4, end: 1.8 }] };
    const s = { ...sug("fix", 1, 1.8, { wordIds: ["m:w0", "m:w1"], text: "Java" }), mediaId: media };
    const p = applyEdits(withWords, adoptEdits(withWords, s)!);
    expect(p.words.map((w) => w.text)).toEqual(["Java"]);
    expect(adoptEdits(base, s)).toBeNull();
  });

  it("要 AI 的種類（遮罩、特效、運鏡）不在這裡處理", () => {
    expect(adoptEdits(base, { ...sug("mask", 1, 2, { target: "API key" }), mediaId: media })).toBeNull();
  });
});

describe("遮罩建議：SAM 分不出螢幕上的文字，用 Spark 回報的框遮", () => {
  const key = { ...sug("mask", 30.8, 42.9, { target: "API key", x: 0.28, y: 0.07, w: 0.25, h: 0.03 }), mediaId: "m" };
  it("金鑰有框 → 不跑 SAM；臉或沒有框 → 跑 SAM", () => {
    expect(maskNeedsSam(key)).toBe(false);
    expect(maskNeedsSam({ ...key, payload: { target: "human face", x: 0.1, y: 0.1, w: 0.2, h: 0.2 } })).toBe(true);
    expect(maskNeedsSam({ ...key, payload: { target: "email address" } })).toBe(true);
  });
  it("框 → 長方形遮罩，整段都有效", () => {
    const m = maskFromBox(key, "k1")!;
    expect(m).toMatchObject({ mediaId: "m", shape: "rect", label: "API key", enabled: true });
    expect(m.samples[0].box.map((v) => Math.round(v * 100) / 100)).toEqual([0.28, 0.07, 0.53, 0.1]);
    for (const t of [30.8, 36, 42.9]) expect(activeSample(m, t)).not.toBeNull();
    expect(activeSample(m, 44)).toBeNull();
  });
});

describe("clampSuggestions：前端再檢查一次（時間夾在片長內、太短或欄位不對的丟掉、依時間排序）", () => {
  it("夾住、丟掉、排序", () => {
    const out = clampSuggestions([
      sug("effect", 50, 55, { description: "x" }),
      sug("cut", -1, 3),
      sug("mask", 10, 12, {}),
      sug("zoom", 20, 20.05, { cx: 0.5, cy: 0.5, w: 0.5 }),
      sug("camera", 90, 120, { scene: "board-float", description: "y" }),
    ], { duration: 100, scenes: new Set(["board-float"]), wordIds: new Set() });
    expect(out.map((s) => [s.kind, s.start, s.end])).toEqual([["cut", 0, 3], ["effect", 50, 55], ["camera", 90, 100]]);
  });
});

describe("建議的編輯", () => {
  it("setSuggestions 換掉同一支素材的建議（重跑導演），其他素材的留著；setSuggestionStatus 改狀態", () => {
    let p = applyEdits(makeProject(), [{ kind: "setSuggestions", mediaId: "a", suggestions: [{ ...sug("cut", 1, 2), mediaId: "a" }] }]);
    p = applyEdits(p, [{ kind: "setSuggestions", mediaId: "b", suggestions: [{ ...sug("cut", 3, 4), mediaId: "b" }] }]);
    p = applyEdits(p, [{ kind: "setSuggestions", mediaId: "a", suggestions: [{ ...sug("zoom", 5, 6), mediaId: "a" }] }]);
    expect(p.suggestions.map((s) => `${s.mediaId}:${s.kind}`).sort()).toEqual(["a:zoom", "b:cut"]);
    p = applyEdits(p, [{ kind: "setSuggestionStatus", id: p.suggestions[0].id, status: "skipped" }]);
    expect(p.suggestions[0].status).toBe("skipped");
  });
});
