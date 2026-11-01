import { describe, expect, it } from "vitest";
import { concatWav, encodeWav, parseWav } from "./wav";

describe("parseWav／concatWav（重配音樣本串接）", () => {
  it("parseWav 讀回格式與 PCM 長度", () => {
    const info = parseWav(encodeWav(new Float32Array([0, 0.5, -0.5, 1]), 16000));
    expect(info).toMatchObject({ rate: 16000, channels: 1, bits: 16 });
    expect(info.data.length).toBe(8);
  });

  it("concatWav 把 PCM 首尾相接，檔頭長度正確，內容逐位元組保留", () => {
    const a = encodeWav(new Float32Array([0.1, 0.2, 0.3]), 16000);
    const b = encodeWav(new Float32Array([-0.4, -0.5]), 16000);
    const out = concatWav([a, b]);
    expect(out.length).toBe(44 + 10);
    const info = parseWav(out);
    expect(info.data.length).toBe(10);
    expect([...info.data.subarray(0, 6)]).toEqual([...parseWav(a).data]);
    expect([...info.data.subarray(6)]).toEqual([...parseWav(b).data]);
    const view = new DataView(out.buffer);
    expect(view.getUint32(4, true)).toBe(36 + 10);
    expect(view.getUint32(40, true)).toBe(10);
  });

  it("容許 fmt 與 data 之間有其他區塊（LIST）", () => {
    const base = encodeWav(new Float32Array([0.25, 0.5]), 16000);
    const list = new Uint8Array([...new TextEncoder().encode("LIST"), 4, 0, 0, 0, 1, 2, 3, 4]);
    const withList = new Uint8Array([...base.subarray(0, 36), ...list, ...base.subarray(36)]);
    expect([...parseWav(withList).data]).toEqual([...parseWav(base).data]);
  });

  it("格式不同、不是 WAV、空清單都丟錯", () => {
    expect(() => concatWav([encodeWav(new Float32Array(2), 16000), encodeWav(new Float32Array(2), 24000)])).toThrow(/different/);
    expect(() => parseWav(new Uint8Array(20))).toThrow();
    expect(() => concatWav([])).toThrow();
  });
});
