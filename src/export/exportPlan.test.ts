import { describe, expect, it } from "vitest";
import { makeProject } from "../core/fixtures";
import { clipFrames, exportPlan } from "./exportPlan";

describe("exportPlan", () => {
  it("依素材：用 V1 第一個片段的素材大小與格率，長度是整個專案", () => {
    const p = makeProject();
    p.media[0] = { ...p.media[0], width: 1920, height: 1080, fps: 30 };
    const plan = exportPlan(p, "source");
    expect(plan).toMatchObject({ width: 1920, height: 1080, fps: 30, duration: 30, frames: 900 });
  });

  it("1080p／720p：高度固定、寬度照素材比例並取偶數", () => {
    const p = makeProject();
    p.media[0] = { ...p.media[0], width: 1366, height: 768, fps: 30 };
    expect(exportPlan(p, "1080p")).toMatchObject({ width: 1920, height: 1080 });
    expect(exportPlan(p, "720p")).toMatchObject({ width: 1280, height: 720 });
    // 依素材但是奇數：往下取偶數（H.264 不收奇數）
    p.media[0] = { ...p.media[0], width: 1281, height: 721 };
    expect(exportPlan(p, "source")).toMatchObject({ width: 1280, height: 720 });
  });

  it("素材沒有大小或格率時用 1920×1080、30 fps；29.97 取整成 30", () => {
    const p = makeProject();
    p.media[0] = { ...p.media[0], width: undefined, height: undefined, fps: undefined };
    expect(exportPlan(p, "source")).toMatchObject({ width: 1920, height: 1080, fps: 30 });
    p.media[0] = { ...p.media[0], width: 1920, height: 1080, fps: 29.97 };
    expect(exportPlan(p, "source").fps).toBe(30);
  });

  it("位元率依像素數與格率縮放（1080p30 約 8 Mbps，下限 1.5 Mbps）", () => {
    const p = makeProject();
    p.media[0] = { ...p.media[0], width: 1920, height: 1080, fps: 30 };
    expect(exportPlan(p, "source").videoBitrate).toBe(8_000_000);
    expect(exportPlan(p, "720p").videoBitrate).toBeCloseTo(8_000_000 * (1280 * 720) / (1920 * 1080), -3);
    p.media[0] = { ...p.media[0], width: 320, height: 180 };
    expect(exportPlan(p, "source").videoBitrate).toBe(1_500_000);
  });

  it("特效比片段長時，長度算到特效結束", () => {
    const p = makeProject();
    p.effects[0] = { ...p.effects[0], start: 28, end: 33 };
    expect(exportPlan(p, "source").duration).toBe(33);
  });
});

describe("clipFrames", () => {
  it("每個影像片段涵蓋的格與每格的素材時間（起點含、終點不含）", () => {
    const p = makeProject();
    const ranges = clipFrames(p, 30, 900);
    const v1b = ranges.find((r) => r.clipId === "v1b")!;
    expect(v1b.first).toBe(300);
    expect(v1b.last).toBe(599);
    expect(v1b.srcTimes[0]).toBeCloseTo(20);
    expect(v1b.srcTimes[v1b.srcTimes.length - 1]).toBeCloseTo(29 + 29 / 30);
    // 音軌片段不算
    expect(ranges.some((r) => r.clipId === "a1a")).toBe(false);
    // 依開始的格排序
    expect(ranges.map((r) => r.clipId)).toEqual(["v1a", "v1b", "v2", "v1c"]);
  });

  it("變速片段的素材時間照速度走；靜音的軌不算", () => {
    const p = makeProject();
    p.clips = p.clips.map((c) => (c.id === "v1a" ? { ...c, speed: 2, srcOut: 20 } : c));
    const v1a = clipFrames(p, 30, 900).find((r) => r.clipId === "v1a")!;
    expect(v1a.srcTimes[30]).toBeCloseTo(2);
    p.tracks = p.tracks.map((t) => (t.id === "V2" ? { ...t, muted: true } : t));
    expect(clipFrames(p, 30, 900).some((r) => r.clipId === "v2")).toBe(false);
  });
});
