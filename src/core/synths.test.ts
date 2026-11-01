import { describe, expect, it } from "vitest";
import { commit, createHistory, undo } from "./history";
import { makeProject } from "./fixtures";
import { addMedia } from "./media";
import { placeLoop } from "./timeline";
import type { Synth } from "./model";

// AI 音效與配樂（spec §5.15，2026-11-01）：規格存進專案（重開可以再改）、配樂放進比一圈長的範圍時接著重複放滿。
describe("配樂循環放滿範圍", () => {
  const withLoop = () => addMedia(makeProject(), [{ id: "loop", kind: "audio", duration: 10 }]);

  it("10 秒一圈放進 5～30 秒：三段首尾相接，最後一段剪到 5 秒", () => {
    const p = placeLoop(withLoop(), "loop", "A2", 5, 30);
    const clips = p.clips.filter((c) => c.mediaId === "loop").sort((a, b) => a.start - b.start);
    expect(clips.map((c) => [c.start, c.srcIn, c.srcOut])).toEqual([[5, 0, 10], [15, 0, 10], [25, 0, 5]]);
    expect(clips.every((c) => c.trackId === "A2")).toBe(true);
  });

  it("範圍比一圈短：只放一段、剪到範圍長度；沒有範圍（end ≤ t）放整圈", () => {
    expect(placeLoop(withLoop(), "loop", "A2", 0, 4).clips.filter((c) => c.mediaId === "loop").map((c) => c.srcOut)).toEqual([4]);
    expect(placeLoop(withLoop(), "loop", "A2", 3, 3).clips.filter((c) => c.mediaId === "loop").map((c) => c.srcOut)).toEqual([10]);
  });

  it("一次復原全部拿掉", () => {
    const h = commit(createHistory(withLoop()), [{ kind: "placeLoop", mediaId: "loop", trackId: "A2", t: 0, end: 25 }]);
    expect(h.present.clips.filter((c) => c.mediaId === "loop")).toHaveLength(3);
    expect(undo(h).present.clips.some((c) => c.mediaId === "loop")).toBe(false);
  });
});

describe("音效與配樂的規格存進專案", () => {
  const synth: Synth = { id: "s1", kind: "music", spec: { bpm: 90 }, source: "ai", renderedMediaId: "loop", label: "calm", prompt: "calm lo-fi" };

  it("addSynth 加進 project.synths；同 id 取代；可以復原", () => {
    const h = commit(createHistory(makeProject()), [{ kind: "addSynth", synth }]);
    expect(h.present.synths).toEqual([synth]);
    const h2 = commit(h, [{ kind: "addSynth", synth: { ...synth, label: "calm v2" } }]);
    expect(h2.present.synths.map((s) => s.label)).toEqual(["calm v2"]);
    expect(undo(h).present.synths).toEqual([]);
  });
});
