import { describe, expect, it } from "vitest";
import { createEngine } from "./createEngine";
import { NotImplementedError } from "./Engine";

describe("createEngine", () => {
  it("在 Tauri 裡回傳桌面版 Engine，能做聲音分離與任何格式匯入", () => {
    const engine = createEngine({ isTauri: () => true });
    expect(engine.kind).toBe("desktop");
    expect(engine.capabilities).toEqual({ vocalSeparation: true, anyFormatImport: true });
  });

  it("在瀏覽器裡回傳網頁版 Engine，不做聲音分離（D28）、只吃 H.264（§5.21）", () => {
    const engine = createEngine({ isTauri: () => false });
    expect(engine.kind).toBe("web");
    expect(engine.capabilities).toEqual({ vocalSeparation: false, anyFormatImport: false });
  });

  it("網頁版呼叫聲音分離會拒絕並指出原因", async () => {
    const engine = createEngine({ isTauri: () => false });
    await expect(engine.separateVocals("media-1")).rejects.toThrow(/Windows app/);
  });

  it("網頁版：專案內的 samples/ 素材對到開發伺服器的 /samples/ 網址；預覽優先用代理檔", () => {
    const engine = createEngine({ isTauri: () => false });
    expect(engine.mediaUrl({ id: "a", kind: "video", duration: 1, path: "samples/lecture-a.en.mp4" })).toBe("/samples/lecture-a.en.mp4");
    expect(engine.mediaUrl({ id: "a", kind: "video", duration: 1, path: "samples/x.mp4", proxyPath: "samples/x.proxy.mp4" })).toBe("/samples/x.proxy.mp4");
  });

  it("還沒實作的功能拋出 NotImplementedError 並帶方法名稱", async () => {
    const engine = createEngine({ isTauri: () => true });
    const error = await engine.makeMezzanine("media-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotImplementedError);
    expect((error as Error).message).toContain("makeMezzanine");
  });
});
