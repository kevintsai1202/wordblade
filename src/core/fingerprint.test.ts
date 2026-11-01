import { describe, expect, it } from "vitest";
import { fingerprintBytes } from "./fingerprint";

// 素材的內容指紋（D41）：和 Rust project.rs 的 fingerprint 同一個算法（大小:頭尾各 1 MB 的 FNV-1a 64），網頁版與桌面版開對方的專案時用它確認是同一支檔案。
describe("內容指紋", () => {
  it("小檔：整支算一次（和 Rust 測試的 abc 一樣）", () => {
    // Rust：format!("3:{:016x}", fnv1a(0xcbf29ce484222325, b"abc"))
    expect(fingerprintBytes(new TextEncoder().encode("abc"), 3)).toBe("3:e71fa2190541574b");
  });

  it("大檔：頭 1 MB＋尾 1 MB；最後一個位元組不同，指紋就不同", () => {
    const big = new Uint8Array(3 << 20).fill(7);
    const head = big.subarray(0, 1 << 20);
    const a = fingerprintBytes(head, big.length, big.subarray(big.length - (1 << 20)));
    big[big.length - 1] = 8;
    const b = fingerprintBytes(head, big.length, big.subarray(big.length - (1 << 20)));
    expect(a.startsWith("3145728:")).toBe(true);
    expect(a).not.toBe(b);
  });
});
