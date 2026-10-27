import { describe, expect, it } from "vitest";
import { boxToVirtual, vibeEffect, type VibeResult } from "./vibe";

const result: VibeResult = {
  refusal: null,
  mode: "compose",
  anim: {
    title: "Arrow + stars",
    layers: [
      { component: "arrow", params: { from: "left" }, start: 0, end: null, fade: { out: 0.3 } },
      { component: "#0", params: {}, start: 0.5, end: 2 },
    ],
    sounds: [{ component: "pop", params: {}, at: 0 }],
  },
  components: [{ kind: "visual", name: "Stars", params: {}, code: "function draw(g){}" }],
  targetPhrase: "",
};

describe("vibeEffect（模型結果 → 時間軸特效）", () => {
  it("圖層引用換成插件雜湊（#n → 新插件、id → 內建），保留框架屬性；音效先不帶", () => {
    const fx = vibeEffect(result, ["h-new0"], (id) => (id === "arrow" ? "h-arrow" : undefined), "fx-1", 4, 2.5, { cx: 0.5, cy: 0.5, w: 0.3, h: 0.2 }, "arrow and stars");
    expect(fx).toEqual({
      id: "fx-1", kind: "anim2d", start: 4, end: 6.5, pluginId: "h-arrow", anchorIds: [],
      params: {
        title: "Arrow + stars",
        box: { cx: 0.5, cy: 0.5, w: 0.3, h: 0.2 },
        layers: [
          { component: "h-arrow", params: { from: "left" }, start: 0, end: null, fade: { out: 0.3 } },
          { component: "h-new0", params: {}, start: 0.5, end: 2 },
        ],
        sounds: [],
        vibe: { description: "arrow and stars", mode: "compose" },
      },
    });
  });

  it("找不到的內建插件 id 會丟錯（要回饋給模型）", () => {
    const bad = { ...result, anim: { ...result.anim, layers: [{ component: "nope", params: {} }] } };
    expect(() => vibeEffect(bad, [], () => undefined, "fx", 0, 1, { cx: 0.5, cy: 0.5, w: 0.2, h: 0.2 }, "x")).toThrow(/layers\[0\]/);
  });
});

describe("boxToVirtual（0～1 的框 → 1080p 虛擬像素）", () => {
  it("16:9 畫面寬 1920", () => {
    expect(boxToVirtual({ cx: 0.5, cy: 0.5, w: 0.25, h: 0.5 }, 16 / 9)).toEqual({ width: 1920, box: { x: 720, y: 270, w: 480, h: 540 } });
  });
});
