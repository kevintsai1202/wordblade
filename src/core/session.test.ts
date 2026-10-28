import { describe, expect, it } from "vitest";
import { makeProject } from "./fixtures";
import { emptyProject } from "./media";
import { restoreSession, serializeSession, shouldSave } from "./session";

// 自動存檔（P0 §5.13 的第一步）：專案存進這台電腦，下次開啟時可以還原。
describe("session", () => {
  it("存了再讀回來一樣；版本不對或內容壞掉回 null", () => {
    const p = makeProject();
    const raw = serializeSession(p, 1730000000000);
    expect(restoreSession(raw)).toEqual({ project: p, savedAt: 1730000000000 });
    expect(restoreSession(null)).toBeNull();
    expect(restoreSession("{oops")).toBeNull();
    expect(restoreSession(JSON.stringify({ v: 99, project: p, savedAt: 1 }))).toBeNull();
    expect(restoreSession(JSON.stringify({ v: 1, project: { clips: 3 }, savedAt: 1 }))).toBeNull();
  });

  it("只有使用者編輯過才存（空專案、剛載入示範專案不存，免得蓋掉上次的工作）", () => {
    expect(shouldSave(emptyProject(), 0, false)).toBe(false);
    expect(shouldSave(makeProject(), 0, true)).toBe(false);
    expect(shouldSave(makeProject(), 1, true)).toBe(true);
    expect(shouldSave(makeProject(), 0, false)).toBe(true);
  });
});
