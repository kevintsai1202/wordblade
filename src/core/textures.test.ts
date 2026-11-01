import { describe, expect, it } from "vitest";
import { commit, createHistory, redo, undo } from "./history";
import { makeProject } from "./fixtures";
import type { TextureAsset } from "./model";

// 材質庫（spec §5.12，P1-14）：Project.textures 的編輯都能復原
describe("材質庫的編輯", () => {
  const tex: TextureAsset = { id: "t1", kind: "texture", name: "worn oak planks", prompt: "worn oak planks", colorMediaId: "m1", normalMediaId: "m2", normalStrength: 1, repeat: 1 };

  it("addTexture 加進 project.textures；同 id 取代；可以復原與重做", () => {
    const h = commit(createHistory(makeProject()), [{ kind: "addTexture", texture: tex }]);
    expect(h.present.textures).toEqual([tex]);
    const h2 = commit(h, [{ kind: "addTexture", texture: { ...tex, colorMediaId: "m3" } }]);
    expect(h2.present.textures).toHaveLength(1);
    expect(h2.present.textures![0].colorMediaId).toBe("m3");
    expect(undo(h).present.textures ?? []).toEqual([]);
    expect(redo(undo(h)).present.textures).toEqual([tex]);
  });

  it("setTexture 只改指定欄位；id 不存在或沒有變化就不留歷史", () => {
    const h = commit(createHistory(makeProject()), [{ kind: "addTexture", texture: tex }]);
    const h2 = commit(h, [{ kind: "setTexture", textureId: "t1", patch: { normalStrength: 1.5 } }]);
    expect(h2.present.textures![0]).toEqual({ ...tex, normalStrength: 1.5 });
    expect(undo(h2).present.textures![0].normalStrength).toBe(1);
    expect(commit(h2, [{ kind: "setTexture", textureId: "t1", patch: { normalStrength: 1.5 } }])).toBe(h2);
    expect(commit(h2, [{ kind: "setTexture", textureId: "nope", patch: { repeat: 3 } }])).toBe(h2);
  });

  it("deleteTexture 拿掉那一筆；可以復原", () => {
    const h = commit(createHistory(makeProject()), [{ kind: "addTexture", texture: tex }, { kind: "addTexture", texture: { ...tex, id: "t2" } }]);
    const h2 = commit(h, [{ kind: "deleteTexture", textureId: "t1" }]);
    expect(h2.present.textures!.map((t) => t.id)).toEqual(["t2"]);
    expect(undo(h2).present.textures!.map((t) => t.id)).toEqual(["t1", "t2"]);
    expect(commit(h2, [{ kind: "deleteTexture", textureId: "nope" }])).toBe(h2);
  });

  it("textures 與素材的 role 都隨專案 JSON 存取", () => {
    const base = makeProject();
    const p = { ...base, media: [...base.media, { id: "m1", kind: "image" as const, duration: 1, role: "texture" as const }], textures: [tex] };
    const back = JSON.parse(JSON.stringify(p));
    expect(back.textures).toEqual([tex]);
    expect(back.media.at(-1).role).toBe("texture");
  });
});
