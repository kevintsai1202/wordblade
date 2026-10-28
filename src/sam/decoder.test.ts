import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeMask } from "./decoder";

// SAM 3.1 遮罩解碼（改寫自 Meta meta_sam_parser 0.0.6，經 transcript-review/backend/face_decode.py）。
// 測試向量照搬原專案 test_face_decode.py（2026-10-06 兩次真實呼叫的遮罩；標準答案以官方 decode_mask_to_raster 算出）：
// (高, 寬, 內容, 點陣 SHA-256, 1 的個數)
const SMALL = [74, 61, "!!!!!XEIJVRwTL+==s=dp(B0^#R)T2FYehCyVpc6-02BY6dsltTmmu.k6dq4]$an[@guI",
  "1ab4475ce0e89afed9650f9fddcc212276ced1abe9a7fddbe5e28e3f2c7cf730", 3519] as const;
const BIG = [246, 217, "!!!!#hBJ7z$2`ev$^I^/?bmc^MlUe{vd'V[Ma`T*IRuoC8U(W1gsP4qF58CVa1xLt5[hYYw9x%km2$mrR)w2@6vT*8k4BbD*Kbevd6Hjuvy'JX66LXSe0m=54+?.*:"
  + "w`wHgr:T_pIRWV4LD6%sRXenYF36ZAY^H%=)D$54#^9FiWtG9eCgZ!7lYZ1P'Le70!!!",
  "770eb2bc1a2b19ed64ac041980aabd3f69d623cbc5cfa9e29aaf9a87b263d249", 39074] as const;

describe("decodeMask（one_bit）", () => {
  it("真實遮罩：點陣雜湊、1 的個數、只有 0／1、臉的中央是 1", () => {
    for (const [h, w, payload, digest, ones] of [SMALL, BIG]) {
      const raster = decodeMask(payload, w, h);
      expect(raster.length).toBe(w * h);
      expect(createHash("sha256").update(raster).digest("hex")).toBe(digest);
      expect(raster.reduce((a, b) => a + b, 0)).toBe(ones);
      expect(raster.every((v) => v === 0 || v === 1)).toBe(true);
      expect(raster[Math.floor(h / 2) * w + Math.floor(w / 2)]).toBe(1);
    }
  });

  it("尺寸不對（多讀或剩下位元組）一律丟錯", () => {
    const [h, w, payload] = BIG;
    for (const [ww, hh] of [[w + 1, h], [w - 1, h], [w, h + 7]]) expect(() => decodeMask(payload, ww, hh)).toThrow();
  });

  it("內容不合法或尺寸不合理一律丟錯；lossless（~）不支援", () => {
    const [h, w, payload] = SMALL;
    for (const bad of [payload.slice(0, -3), payload.slice(0, 4), payload.slice(0, 20) + "|" + payload.slice(21), payload + "zz", "xyz", "", "!", "!!!!!}", "!!!!!~"]) {
      expect(() => decodeMask(bad, w, h), bad).toThrow();
    }
    for (const [ww, hh] of [[0, h], [w, -1], [1.5, h], [100000, 100000]]) expect(() => decodeMask(payload, ww, hh)).toThrow();
    expect(() => decodeMask("~!!!!!", 4, 4)).toThrow();
  });
});
