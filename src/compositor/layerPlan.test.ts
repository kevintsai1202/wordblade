import { describe, expect, it } from "vitest";
import { makeProject } from "../core/fixtures";
import type { Effect, Project } from "../core/model";
import { layerPlan } from "./layerPlan";

/** 加一個特效 */
function withEffect(p: Project, id: string, kind: Effect["kind"], start: number, end: number): Project {
  return { ...p, effects: [...p.effects, { id, kind, start, end, pluginId: "x", params: {}, anchorIds: [] }] };
}

/** 只留種類與 id，方便比對順序 */
const shape = (p: Project, t: number) => layerPlan(p, t, 30).map((x) => (x.kind === "video" ? `video:${x.layer.clipId}` : `${x.kind}:${x.effectId}`));

describe("layerPlan（§5.10 疊放順序）", () => {
  it("V1 → 3D 場景 → V2 以上 → 2D／3D 插件（插件依起點）", () => {
    let p = withEffect(makeProject(), "scene", "scene3d", 12, 14);
    p = withEffect(p, "fx2d", "anim2d", 11, 14);
    p = withEffect(p, "fx3d", "anim3d", 12.5, 13);
    p = { ...p, effects: p.effects.filter((e) => e.id !== "e1") };
    expect(shape(p, 12.8)).toEqual(["video:v1b", "scene:scene", "video:v2", "overlay:fx2d", "overlay:fx3d"]);
  });

  it("特效帶區段內的格數與長度；終點不含", () => {
    const p = withEffect({ ...makeProject(), effects: [] }, "s", "scene3d", 2, 4);
    expect(layerPlan(p, 3, 30).find((x) => x.kind === "scene")).toEqual({ kind: "scene", effectId: "s", frame: 30, duration: 2 });
    expect(layerPlan(p, 4, 30).some((x) => x.kind === "scene")).toBe(false);
  });

  it("沒有特效時就是影像圖層（V1 在下）", () => {
    expect(shape({ ...makeProject(), effects: [] }, 12.5)).toEqual(["video:v1b", "video:v2"]);
  });
});
