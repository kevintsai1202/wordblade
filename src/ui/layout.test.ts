import { describe, expect, it } from "vitest";
import { DEFAULT_LAYOUT, clampLayout, parseLayout } from "./layout";

// 主畫面區塊大小（開發者 2026-10-28）：三條分隔線的位置記在這台電腦，讀回來時壞掉或超出範圍要能自我修正
describe("layout", () => {
  it("沒有存過或內容壞掉：用預設（右側面板 380、時間軸 300、軌道標頭 88）", () => {
    expect(DEFAULT_LAYOUT).toEqual({ panelWidth: 380, timelineHeight: 300, headerWidth: 88 });
    expect(parseLayout(null)).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("{oops")).toEqual(DEFAULT_LAYOUT);
    expect(parseLayout("[1,2]")).toEqual(DEFAULT_LAYOUT);
  });

  it("只有部分欄位或型別不對：其他用預設", () => {
    expect(parseLayout(JSON.stringify({ panelWidth: 500, timelineHeight: "x" }))).toEqual({ ...DEFAULT_LAYOUT, panelWidth: 500 });
  });

  it("超出範圍就夾住（右側面板 280～900、時間軸 160～800、軌道標頭 60～240），取整數", () => {
    expect(clampLayout({ panelWidth: 100, timelineHeight: 5000, headerWidth: 300.7 })).toEqual({ panelWidth: 280, timelineHeight: 800, headerWidth: 240 });
    expect(clampLayout({ panelWidth: 456.4, timelineHeight: 222.6, headerWidth: 70 })).toEqual({ panelWidth: 456, timelineHeight: 223, headerWidth: 70 });
  });
});
