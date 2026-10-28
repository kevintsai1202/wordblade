import { describe, expect, it } from "vitest";
import { flipIntro, FLIP_DEFAULTS } from "./flip";

// 翻頁式片頭的 cue 表（spec §5.23、調查 §1.4、§3.4）：以揭曉時間為錨點，翻頁越翻越快、最短 2 格，畫面與聲音都從這份表衍生。
const images = Array.from({ length: 16 }, (_, i) => `img${i}`);

describe("flipIntro：翻頁時間", () => {
  it("沒有配樂（揭曉 3.2 秒）：重現 brand-v2 短版——0.9 秒起翻 16 頁、第 10 頁起 2 格、2.7 秒前翻完", () => {
    const plan = flipIntro({ imageIds: images, title: "Hello", fps: 30, seed: 1 });
    const pages = plan.cues.filter((c) => c.kind === "page");
    expect(plan.reveal).toBe(3.2);
    expect(pages).toHaveLength(16);
    expect(pages[0].t).toBeCloseTo(0.9, 6);
    expect(pages[1].t - pages[0].t).toBeCloseTo(0.26, 6);
    expect(pages[15].t).toBeLessThan(2.7);
    expect(pages[15].t).toBeGreaterThan(2.6);
    // 第 10 頁停留 0.0669 秒（剛好比 2 格多一點），第 11 頁起都是 2 格
    expect(pages[10].t - pages[9].t).toBeCloseTo(2 / 30, 3);
    for (let i = 11; i < 16; i++) expect(pages[i].t - pages[i - 1].t).toBeCloseTo(2 / 30, 6);
    // 越來越快，強度遞減
    expect(pages[0].strength).toBe(1);
    expect(pages[15].strength).toBeCloseTo(0.55, 6);
  });

  it("內建配樂（揭曉 4.0 秒＝120 BPM 第 3 小節）：整段往後移，閃光、上升音、揭曉、結尾都對", () => {
    const plan = flipIntro({ imageIds: images, title: "Hello", fps: 30, seed: 1, reveal: 4, duration: 8 });
    const at = (kind: string) => plan.cues.find((c) => c.kind === kind)!.t;
    expect(at("page")).toBeCloseTo(1.7, 6);
    expect(at("flash")).toBeCloseTo(3.46, 6);
    expect(at("riserStart")).toBeCloseTo(1.5, 6);
    expect(at("titleIn")).toBeCloseTo(3.5, 6);
    expect(at("reveal")).toBe(4);
    expect(at("end")).toBe(8);
    expect(plan.duration).toBe(8);
  });

  it("最短間隔隨 fps：60 fps 時是 2 格＝1/30 秒，翻得更多頁但不超過頁數", () => {
    const plan = flipIntro({ imageIds: images, title: "x", fps: 60, seed: 1, params: { pages: 30 } });
    const pages = plan.cues.filter((c) => c.kind === "page");
    const gaps = pages.slice(1).map((p, i) => p.t - pages[i].t);
    expect(Math.min(...gaps)).toBeCloseTo(2 / 60, 6);
    expect(pages.length).toBeLessThanOrEqual(30);
    expect(pages[pages.length - 1].t).toBeLessThan(plan.reveal - 0.5);
  });
});

describe("flipIntro：圖片", () => {
  it("同一個 seed 洗牌結果相同、不同 seed 不同；每張圖都用到", () => {
    const a = flipIntro({ imageIds: images, title: "x", fps: 30, seed: 7 });
    const b = flipIntro({ imageIds: images, title: "x", fps: 30, seed: 7 });
    const c = flipIntro({ imageIds: images, title: "x", fps: 30, seed: 8 });
    expect(a.pageImages).toEqual(b.pageImages);
    expect(a.pageImages).not.toEqual(c.pageImages);
    expect(new Set(a.pageImages)).toEqual(new Set(images));
    expect(a.titleFills).toHaveLength(FLIP_DEFAULTS.titleFills);
  });

  it("圖片不夠就循環使用並提示；沒有圖片回錯誤", () => {
    const plan = flipIntro({ imageIds: ["a", "b", "c"], title: "x", fps: 30, seed: 1 });
    expect(plan.pageImages).toHaveLength(16);
    expect(new Set(plan.pageImages)).toEqual(new Set(["a", "b", "c"]));
    // 相鄰兩頁不要同一張
    for (let i = 1; i < plan.pageImages.length; i++) expect(plan.pageImages[i]).not.toBe(plan.pageImages[i - 1]);
    expect(plan.warnings.join(" ")).toMatch(/8/);
    expect(() => flipIntro({ imageIds: [], title: "x", fps: 30, seed: 1 })).toThrow();
  });
});
