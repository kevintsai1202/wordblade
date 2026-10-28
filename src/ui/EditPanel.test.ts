import { describe, expect, it } from "vitest";
import { TAB_GROUPS, groupOf } from "./EditPanel";

// 右側面板的大類別（開發者 2026-10-28）：子頁籤 id 唯一，App 與 openTab 都用子頁籤 id
describe("EditPanel 分組", () => {
  it("六個大類別；子頁籤 id 不重複", () => {
    expect(TAB_GROUPS.map((g) => g.id)).toEqual(["media", "transcript", "effects", "inspector", "director", "export"]);
    const ids = TAB_GROUPS.flatMap((g) => g.leaves.map((l) => l.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("特效下分 2D／3D／Zoom／Mask／Sound／Intro；子頁籤找得到所屬大類別", () => {
    expect(groupOf("vibe").id).toBe("effects");
    expect(TAB_GROUPS.find((g) => g.id === "effects")!.leaves.map((l) => l.label)).toEqual(["2D", "3D", "Zoom", "Mask", "Sound", "Intro"]);
    expect(groupOf("vibe3d").id).toBe("effects");
    expect(groupOf("style").id).toBe("transcript");
    expect(groupOf("publish").id).toBe("export");
    expect(groupOf("nope").id).toBe("media");
  });
});
