import { describe, expect, it } from "vitest";
import { makeProject } from "./fixtures";
import { addMedia, emptyProject, IMAGE_DURATION, patchMedia } from "./media";
import type { Project } from "./model";
import { nearestV1EditPoint, placeMedia } from "./timeline";

/** 某條軌道上的片段，依起點排序，只留比對用的欄位 */
function track(p: Project, trackId: string) {
  return p.clips
    .filter((c) => c.trackId === trackId)
    .sort((a, b) => a.start - b.start)
    .map((c) => ({ mediaId: c.mediaId, srcIn: c.srcIn, srcOut: c.srcOut, start: c.start }));
}

/** 測試專案加上一支 4 秒的新影片、一張圖、一段音效、一支無聲影片；lock 給的軌先鎖定（addMedia 回傳的物件已凍結，不能事後改） */
function withNewMedia(lock: string[] = []): Project {
  const base = makeProject();
  for (const t of base.tracks) if (lock.includes(t.id)) t.locked = true;
  return addMedia(base, [
    { id: "new", kind: "video", duration: 4, fps: 30, audio: true },
    { id: "img", kind: "image", duration: IMAGE_DURATION, width: 800, height: 600 },
    { id: "sfx", kind: "audio", duration: 1.5 },
    { id: "mute", kind: "video", duration: 3, fps: 30, audio: false },
  ]);
}

describe("emptyProject／addMedia", () => {
  it("空專案有 V1、V2、A1 對白、A2 配樂、A3 音效，沒有片段", () => {
    const p = emptyProject();
    expect(p.tracks.map((t) => [t.id, t.kind, t.index, t.role])).toEqual([
      ["V1", "video", 0, undefined],
      ["V2", "video", 1, undefined],
      ["A1", "audio", 0, "dialogue"],
      ["A2", "audio", 1, "music"],
      ["A3", "audio", 2, "sfx"],
    ]);
    expect(p.clips).toEqual([]);
  });

  it("addMedia 加到素材庫；同 id 的不重複加", () => {
    const p = addMedia(emptyProject(), [{ id: "x", kind: "audio", duration: 1 }]);
    expect(addMedia(p, [{ id: "x", kind: "audio", duration: 1 }]).media).toHaveLength(1);
  });
});

describe("nearestV1EditPoint", () => {
  it("找最近的 V1 剪接點（含 0 與結尾）", () => {
    const p = makeProject(); // V1：0～10、10～20、20～30
    expect(nearestV1EditPoint(p, 3)).toBe(0);
    expect(nearestV1EditPoint(p, 8)).toBe(10);
    expect(nearestV1EditPoint(p, 99)).toBe(30);
  });

  it("V1 沒有片段時是 0", () => {
    expect(nearestV1EditPoint(emptyProject(), 12)).toBe(0);
  });
});

describe("placeMedia：放到 V1（插入最近剪接點並漣漪，D25 反向）", () => {
  it("影片插在剪接點 10：V1 與 A1 各插一段，後面的片段右移 4 秒", () => {
    const out = placeMedia(withNewMedia(), "new", "V1", 11);
    expect(track(out, "V1")).toEqual([
      { mediaId: "m1", srcIn: 0, srcOut: 10, start: 0 },
      { mediaId: "new", srcIn: 0, srcOut: 4, start: 10 },
      { mediaId: "m1", srcIn: 20, srcOut: 30, start: 14 },
      { mediaId: "m2", srcIn: 0, srcOut: 10, start: 24 },
    ]);
    expect(track(out, "A1")).toEqual([
      { mediaId: "m1", srcIn: 0, srcOut: 10, start: 0 },
      { mediaId: "new", srcIn: 0, srcOut: 4, start: 10 },
      { mediaId: "m1", srcIn: 20, srcOut: 30, start: 14 },
      { mediaId: "m2", srcIn: 0, srcOut: 10, start: 24 },
    ]);
  });

  it("疊加軌在插入點之後的片段右移", () => {
    const out = placeMedia(withNewMedia(), "new", "V1", 10);
    expect(track(out, "V2")).toEqual([{ mediaId: "m2", srcIn: 50, srcOut: 55, start: 16 }]);
  });

  it("跨在插入點上的配樂：切開，後半段右移（中間空出新片段的長度）", () => {
    const out = placeMedia(withNewMedia(), "new", "V1", 10);
    expect(track(out, "A2")).toEqual([
      { mediaId: "mus", srcIn: 0, srcOut: 10, start: 0 },
      { mediaId: "mus", srcIn: 10, srcOut: 30, start: 14 },
    ]);
  });

  it("鎖定的軌不動", () => {
    const p = withNewMedia(["A2"]);
    expect(track(placeMedia(p, "new", "V1", 10), "A2")).toEqual([{ mediaId: "mus", srcIn: 0, srcOut: 30, start: 0 }]);
  });

  it("特效：之後的右移、跨在插入點上的拉長並依比例拉開鏡頭關鍵幀；定位點之後的右移", () => {
    const out = placeMedia(withNewMedia(), "new", "V1", 10); // 特效 8～12、關鍵幀 0、4
    expect([out.effects[0].start, out.effects[0].end]).toEqual([8, 16]);
    expect(out.effects[0].cameraKeys!.map((k) => k.t)).toEqual([0, 8]);
    expect(out.anchors.map((a) => [a.id, a.time])).toEqual([["an1", 19], ["an2", 9.5]]);
  });

  it("沒有聲音的影片只放 V1；圖片預設 5 秒", () => {
    const out = placeMedia(placeMedia(withNewMedia(), "mute", "V1", 30), "img", "V1", 0);
    expect(track(out, "V1")[0]).toEqual({ mediaId: "img", srcIn: 0, srcOut: 5, start: 0 });
    expect(track(out, "V1").slice(-1)[0]).toEqual({ mediaId: "mute", srcIn: 0, srcOut: 3, start: 35 });
    expect(track(out, "A1").some((c) => c.mediaId === "mute")).toBe(false);
  });

  it("新片段的 id 不重複", () => {
    const out = placeMedia(placeMedia(withNewMedia(), "new", "V1", 0), "new", "V1", 0);
    expect(new Set(out.clips.map((c) => c.id)).size).toBe(out.clips.length);
  });
});

describe("placeMedia：其他軌（不漣漪）", () => {
  it("影片放 V2：放在拖放時間，聲音放 A1 同一時間，其他片段不動", () => {
    const p = withNewMedia();
    const out = placeMedia(p, "new", "V2", 3.5);
    expect(track(out, "V2")[0]).toEqual({ mediaId: "new", srcIn: 0, srcOut: 4, start: 3.5 });
    expect(track(out, "A1").filter((c) => c.mediaId === "new")).toEqual([{ mediaId: "new", srcIn: 0, srcOut: 4, start: 3.5 }]);
    expect(track(out, "V1")).toEqual(track(p, "V1"));
  });

  it("音效放 A2：只放聲音；負的時間夾到 0", () => {
    const out = placeMedia(withNewMedia(), "sfx", "A2", -2);
    expect(track(out, "A2").filter((c) => c.mediaId === "sfx")).toEqual([{ mediaId: "sfx", srcIn: 0, srcOut: 1.5, start: 0 }]);
  });

  it("影片拖到音軌：只放它的聲音", () => {
    const out = placeMedia(withNewMedia(), "new", "A2", 40);
    expect(track(out, "A2").slice(-1)[0]).toEqual({ mediaId: "new", srcIn: 0, srcOut: 4, start: 40 });
    expect(out.clips.filter((c) => c.mediaId === "new")).toHaveLength(1);
  });

  it("放不下的組合原樣回傳：音訊拖到影像軌、圖片或無聲影片拖到音軌、鎖定的軌、不存在的素材", () => {
    const p = withNewMedia();
    expect(placeMedia(p, "sfx", "V2", 0)).toBe(p);
    expect(placeMedia(p, "img", "A2", 0)).toBe(p);
    expect(placeMedia(p, "mute", "A2", 0)).toBe(p);
    expect(placeMedia(p, "nope", "V1", 0)).toBe(p);
    const locked = withNewMedia(["V2"]);
    expect(placeMedia(locked, "new", "V2", 0)).toBe(locked);
  });
});

describe("patchMedia（core）", () => {
  it("只改指定素材，其他物件共用", () => {
    const p = makeProject();
    const out = patchMedia(p, "m2", { proxyPath: "x.mp4" });
    expect(out.media.find((m) => m.id === "m2")!.proxyPath).toBe("x.mp4");
    expect(out.clips).toBe(p.clips);
  });
});
