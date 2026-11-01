import { describe, expect, it } from "vitest";
import { isTextureRef, resolveTextureRefs, rewriteTextureRefs } from "./textureRefs";

describe("材質引用 → 沙盒的 __textures", () => {
  it("沒有引用：圖片清單不變、textures 是 null", () => {
    expect(resolveTextureRefs({ scene: "desk", imageIds: ["a"] }, ["a"])).toEqual({ ids: ["a"], textures: null });
  });

  it("引用的圖接在 imageIds 後面，map／normal 是清單索引，重複的圖共用同一格", () => {
    const params = {
      frameTexture: { textureId: "t1", color: "m1", normal: "m2", repeat: 2, normalStrength: 0.5 },
      wallTexture: { textureId: "t2", color: "m1" },
      backgroundImage: { textureId: "t3", color: "m3" },
    };
    const r = resolveTextureRefs(params, ["cover"]);
    expect(r.ids).toEqual(["cover", "m1", "m2", "m3"]);
    expect(r.textures).toEqual({
      frameTexture: { map: 1, normal: 2, repeat: 2, normalStrength: 0.5 },
      wallTexture: { map: 1, normal: null, repeat: 1, normalStrength: 1 },
      backgroundImage: { map: 3, normal: null, repeat: 1, normalStrength: 1 },
    });
  });

  it("null（預設）與不是引用的值略過", () => {
    expect(isTextureRef(null)).toBe(false);
    expect(isTextureRef({ textureId: "x" })).toBe(false);
    expect(resolveTextureRefs({ frameTexture: null, tilt: 7 }, []).textures).toBeNull();
  });
});

describe("改寫特效參數裡的引用", () => {
  const effectParams = { title: "x", params: { frameTexture: { textureId: "t1", color: "m1" }, wallTexture: { textureId: "t2", color: "m9" }, tilt: 7 } };

  it("只改指向該材質的引用", () => {
    const r = rewriteTextureRefs(effectParams, "t1", (ref) => ({ ...ref, color: "m5", normalStrength: 2 }));
    expect(r.params).toEqual({ frameTexture: { textureId: "t1", color: "m5", normalStrength: 2 }, wallTexture: { textureId: "t2", color: "m9" }, tilt: 7 });
  });

  it("回傳 null 就拿掉引用", () => {
    const r = rewriteTextureRefs(effectParams, "t2", () => null);
    expect((r.params as Record<string, unknown>).wallTexture).toBeNull();
  });

  it("沒有引用到的材質：回傳原物件（不產生多餘的編輯）", () => {
    expect(rewriteTextureRefs(effectParams, "nope", (r) => r)).toBe(effectParams);
    expect(rewriteTextureRefs({ layers: [] }, "t1", (r) => r)).toEqual({ layers: [] });
  });
});
