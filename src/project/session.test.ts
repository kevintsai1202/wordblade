import { describe, expect, it } from "vitest";
import { makeProject } from "../core/fixtures";
import { fromProjectFile } from "../core/projectFile";
import type { Media } from "../core/model";
import { exportPathFor, loadProjectText, projectText, pushRecent, relinkMissing } from "./session";

// 專案資料夾的存與開（D41）：存的時候補上素材指紋（算過的記住）、開的時候逐支找回素材、最近開啟清單、匯出預設位置。
const location = { name: "MyTalk", dir: "D:\\videos\\MyTalk.wordblade" };

describe("projectText：存之前補指紋，同一支素材只算一次", () => {
  it("有路徑的素材算指紋並寫進 project.json", async () => {
    const p = makeProject();
    p.media = p.media.map((m, i) => ({ ...m, path: `D:\\videos\\clip-${i}.mp4` }));
    const cache = new Map<string, string>();
    let calls = 0;
    const fp = async (m: Media) => { calls++; return `fp-${m.id}`; };
    const text = await projectText(p, location, cache, fp, 7);
    await projectText(p, location, cache, fp, 8);
    expect(calls).toBe(p.media.length);
    const back = fromProjectFile(text)!;
    expect(back.refs[p.media[0].id]).toMatchObject({ rel: "../clip-0.mp4", fingerprint: `fp-${p.media[0].id}` });
  });
});

describe("loadProjectText：開專案", () => {
  it("找回素材；找不到的列名稱；壞掉的檔回錯誤訊息", async () => {
    const p = makeProject();
    p.media = p.media.map((m, i) => ({ ...m, name: `clip-${i}.mp4`, path: `D:\\videos\\clip-${i}.mp4` }));
    const text = await projectText(p, location, new Map(), async () => undefined, 1);
    const moved = { name: "MyTalk", dir: "E:\\moved\\MyTalk.wordblade" };
    const result = await loadProjectText(text, moved, async (m, candidates) => (m.id === p.media[0].id ? { ...m, path: candidates[0] } : null));
    if ("error" in result) throw new Error(result.error);
    expect(result.project.media[0].path).toBe("E:\\moved\\clip-0.mp4");
    expect(result.missing.map((x) => x.name)).toEqual(p.media.slice(1).map((m) => m.name));
    expect(result.missing[0].id).toBe(p.media[1].id);
    const bad = await loadProjectText("{", moved, async () => null);
    expect(bad).toEqual({ error: expect.stringContaining("project.json") });
  });
});

describe("relinkMissing：重新連結一支，同資料夾裡其他遺失的素材一起找回", () => {
  it("選的檔直接採用；其他遺失的用原檔名在同一個資料夾找（比指紋）", async () => {
    const media = ["a.mp4", "b.mp4", "c.mp4"].map((name, i) => ({ ...makeProject().media[0], id: `m${i}`, name, path: `D:\\old\\${name}` }));
    const missing = media.map((m) => ({ id: m.id, name: m.name, fingerprint: `fp-${m.id}` }));
    const calls: { id: string; candidates: string[]; fingerprint?: string }[] = [];
    const found = await relinkMissing(media[0], "E:\\new\\a-renamed.mp4", media, missing, async (m, candidates, fingerprint) => {
      calls.push({ id: m.id, candidates, fingerprint });
      return m.id === "m2" ? null : { ...m, path: candidates[0] };
    });
    expect(calls[0]).toEqual({ id: "m0", candidates: ["E:\\new\\a-renamed.mp4"], fingerprint: undefined });
    expect(calls.slice(1)).toEqual([
      { id: "m1", candidates: ["E:\\new\\b.mp4"], fingerprint: "fp-m1" },
      { id: "m2", candidates: ["E:\\new\\c.mp4"], fingerprint: "fp-m2" },
    ]);
    expect(found).toEqual([{ id: "m0", path: "E:\\new\\a-renamed.mp4" }, { id: "m1", path: "E:\\new\\b.mp4" }]);
  });

  it("選的檔打不開就什麼都不換", async () => {
    const m = { ...makeProject().media[0], path: "D:\\old\\a.mp4" };
    expect(await relinkMissing(m, "E:\\x.mp4", [m], [{ id: m.id, name: "a" }], async () => null)).toEqual([]);
  });
});

describe("最近開啟與匯出位置", () => {
  it("最近開啟：最新的在前、同一個只留一筆、最多 8 筆", () => {
    let list = pushRecent([], { name: "a", dir: "D:\\a.wordblade" }, 1);
    list = pushRecent(list, { name: "b", dir: "D:\\b.wordblade" }, 2);
    list = pushRecent(list, { name: "a", dir: "D:\\a.wordblade" }, 3);
    expect(list.map((r) => r.name)).toEqual(["a", "b"]);
    for (let i = 0; i < 10; i++) list = pushRecent(list, { name: `x${i}`, dir: `D:\\x${i}.wordblade` }, 10 + i);
    expect(list).toHaveLength(8);
  });

  it("匯出預設放在專案資料夾旁邊（同一層），檔名是專案名", () => {
    expect(exportPathFor(location, "mp4")).toBe("D:\\videos\\MyTalk.mp4");
    expect(exportPathFor(null, "mp4")).toBe("wordblade-export.mp4");
  });
});
