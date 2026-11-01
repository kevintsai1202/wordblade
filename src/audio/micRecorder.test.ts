import { describe, expect, it } from "vitest";
import { MIC_TIMEOUT_MS, peakOf, shouldFallback } from "./micRecorder";

// 錄音（spec §5.18，2026-11-01）：getUserMedia 失敗時哪些情況改用 Windows 錄音機、錄完檢查峰值（削峰提示）。
describe("錄音退路的判斷", () => {
  it("被擋（NotReadableError、NotAllowedError）或逾時：Windows 版改用錄音機；網頁版不退", () => {
    for (const name of ["NotReadableError", "NotAllowedError", "timeout"]) {
      expect(shouldFallback(name, "desktop")).toBe(true);
      expect(shouldFallback(name, "web")).toBe(false);
    }
  });

  it("沒有麥克風（NotFoundError）不退，直接提示", () => {
    expect(shouldFallback("NotFoundError", "desktop")).toBe(false);
  });

  it("逾時是 8 秒", () => {
    expect(MIC_TIMEOUT_MS).toBe(8000);
  });
});

describe("峰值", () => {
  it("取所有聲道的絕對值最大", () => {
    expect(peakOf([new Float32Array([0.1, -0.5]), new Float32Array([0.3, 0.2])])).toBeCloseTo(0.5);
  });
});
