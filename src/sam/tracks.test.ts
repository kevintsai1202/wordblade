import { describe, expect, it } from "vitest";
import { activeSample, buildParts, cutsFromDiffs, linkPasses, toMaskObjects, type SamPass } from "./tracks";
import type { SamFrame, SamRecord } from "./stream";

// 遮罩物件的整理（照搬 transcript-review face_track._is_cut、face_matte.split_parts／link_faces／sample_of）：
// 換鏡頭（像素差突增）、同一個 SAM id 在換鏡頭／消失超過 1 秒／中心跳太遠／框寬差 1.6 倍時拆開、分段請求之間用 IoU ≥ 0.3 接起來、
// 播放時取最近的取樣（取樣之間形狀不動）。

/** 一筆記錄（小檔 100×100） */
const rec = (id: number, x1: number, y1: number, x2: number, y2: number): SamRecord => ({ id, x1, y1, x2, y2, w: 100, h: 100, mask: null });
/** 每格一筆記錄 */
const frames = (list: [number, SamRecord[]][]): SamFrame[] => list.map(([frame, records]) => ({ frame, records }));

describe("cutsFromDiffs", () => {
  it("差異 ≥ 12 且是前後 6 格中位數（較大那邊）的 3 倍以上才是換鏡頭；頭一格不算", () => {
    expect(cutsFromDiffs([0, 1, 2, 1, 40, 1, 2, 1])).toEqual([4]);
    expect(cutsFromDiffs([0, 1, 2, 1, 10, 1, 2, 1])).toEqual([]);
    // 一直在動（前後都很大）不算
    expect(cutsFromDiffs([0, 20, 22, 25, 30, 21, 24, 20])).toEqual([]);
    // 只有一邊有資料（區間最後一格）用那一邊
    expect(cutsFromDiffs([0, 1, 1, 1, 50])).toEqual([4]);
    // 閃光：連續兩格突增算兩次
    expect(cutsFromDiffs([0, 1, 1, 1, 60, 60, 1, 1, 1])).toEqual([4, 5]);
  });
});

describe("buildParts", () => {
  const pass = (list: [number, SamRecord[]][], cuts: number[] = []): SamPass => ({ start: 0, fps: 10, clipW: 100, clipH: 100, frames: frames(list), cuts });

  it("同一個 id 一直在：一段", () => {
    const parts = buildParts(pass([[0, [rec(0, 10, 10, 30, 30)]], [1, [rec(0, 11, 10, 31, 30)]], [2, [rec(0, 12, 10, 32, 30)]]]));
    expect(parts).toHaveLength(1);
    expect(parts[0].boxes.map((b) => b.sample)).toEqual([0, 1, 2]);
  });

  it("換鏡頭、消失超過 1 秒、中心跳太遠、框寬差太多都拆開", () => {
    expect(buildParts(pass([[0, [rec(0, 10, 10, 30, 30)]], [1, [rec(0, 10, 10, 30, 30)]]], [1]))).toHaveLength(2);
    expect(buildParts(pass([[0, [rec(0, 10, 10, 30, 30)]], [12, [rec(0, 10, 10, 30, 30)]]]))).toHaveLength(2);
    expect(buildParts(pass([[0, [rec(0, 10, 10, 30, 30)]], [10, [rec(0, 10, 10, 30, 30)]]]))).toHaveLength(1);
    expect(buildParts(pass([[0, [rec(0, 10, 10, 30, 30)]], [1, [rec(0, 60, 10, 80, 30)]]]))).toHaveLength(2);
    expect(buildParts(pass([[0, [rec(0, 10, 10, 30, 30)]], [1, [rec(0, 10, 10, 45, 30)]]]))).toHaveLength(2);
  });
});

describe("linkPasses＋toMaskObjects", () => {
  it("分段請求重疊的那一格 IoU ≥ 0.3 就接成同一個物件；不夠就是不同物件；時間、位置正規化", () => {
    const a: SamPass = { start: 0, fps: 10, clipW: 100, clipH: 100, cuts: [], frames: frames([[0, [rec(0, 10, 10, 30, 30)]], [1, [rec(0, 10, 10, 30, 30)]]]) };
    // 第二段從 0.1 秒（a 的第 1 格）開始：同一個人 id 換成 5；另一個人在別處
    const b: SamPass = { start: 0.1, fps: 10, clipW: 100, clipH: 100, cuts: [], frames: frames([[0, [rec(5, 11, 10, 31, 30), rec(6, 70, 70, 90, 90)]], [1, [rec(5, 12, 10, 32, 30), rec(6, 70, 70, 90, 90)]]]) };
    const objects = toMaskObjects(linkPasses([a, b]), { mediaId: "m", prompt: "person", idPrefix: "mask" });
    expect(objects.map((o) => o.label)).toEqual(["person 1", "person 2"]);
    expect(objects[0].samples.map((s) => s.t)).toEqual([0, 0.1, 0.2]);
    expect(objects[0].samples[0].box).toEqual([0.1, 0.1, 0.3, 0.3]);
    expect(objects[1].samples.map((s) => s.t)).toEqual([0.1, 0.2]);
    expect(objects[0].interval).toBeCloseTo(0.1);
  });
});

describe("activeSample：取最近的取樣，第一個之前半格、最後一個之後一格內有效", () => {
  const obj = toMaskObjects(linkPasses([{ start: 5, fps: 10, clipW: 100, clipH: 100, cuts: [], frames: frames([[0, [rec(0, 0, 0, 10, 10)]], [3, [rec(0, 5, 0, 15, 10)]]]) }]), { mediaId: "m", prompt: "x", idPrefix: "k" })[0];
  it("最近的一張", () => {
    expect(activeSample(obj, 5.1)!.t).toBe(5);
    expect(activeSample(obj, 5.2)!.t).toBe(5.3);
    expect(activeSample(obj, 5.39)!.t).toBe(5.3);
  });
  it("範圍外沒有", () => {
    expect(activeSample(obj, 4.9)).toBeNull();
    expect(activeSample(obj, 5.41)).toBeNull();
  });
});
