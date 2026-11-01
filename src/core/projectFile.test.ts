import { describe, expect, it } from "vitest";
import { makeProject } from "./fixtures";
import { externalizeMasks, fromProjectFile, internalizeMasks, joinPath, relativePath, relinkCandidates, relinkProject, toProjectFile } from "./projectFile";
import type { MaskObject } from "./model";

// 專案資料夾的 project.json（D41）：素材用路徑參照（絕對＋相對專案資料夾＋內容指紋），搬家後依序找。
describe("路徑", () => {
  it("相對路徑：Windows 與 POSIX 都可、一律用 / 存；不同磁碟機回 null", () => {
    expect(relativePath("D:\\videos\\MyTalk.wordblade", "D:\\videos\\rec-1.mp4")).toBe("../rec-1.mp4");
    expect(relativePath("D:\\videos\\MyTalk.wordblade", "D:\\videos\\raw\\a b.mp4")).toBe("../raw/a b.mp4");
    expect(relativePath("D:/videos/MyTalk.wordblade", "d:/Videos/rec-1.mp4")).toBe("../rec-1.mp4");
    expect(relativePath("D:\\videos\\MyTalk.wordblade", "E:\\x.mp4")).toBeNull();
    expect(relativePath("/home/k/MyTalk.wordblade", "/home/k/clips/x.mp4")).toBe("../clips/x.mp4");
  });

  it("相對路徑換回絕對路徑：照專案資料夾的分隔符號", () => {
    expect(joinPath("D:\\moved\\MyTalk.wordblade", "../rec-1.mp4")).toBe("D:\\moved\\rec-1.mp4");
    expect(joinPath("/home/k/MyTalk.wordblade", "../clips/x.mp4")).toBe("/home/k/clips/x.mp4");
  });
});

describe("project.json", () => {
  const p = makeProject();
  p.media = p.media.map((m, i) => ({ ...m, path: `D:\\videos\\clip-${i}.mp4` }));

  it("寫出再讀回：專案一樣、每支素材記絕對＋相對路徑與指紋", () => {
    const text = toProjectFile(p, { projectDir: "D:\\videos\\MyTalk.wordblade", savedAt: 5, fingerprints: { [p.media[0].id]: "abc" } });
    const json = JSON.parse(text);
    expect(json.format).toBe("wordblade-project");
    expect(json.media[p.media[0].id]).toEqual({ path: "D:\\videos\\clip-0.mp4", rel: "../clip-0.mp4", fingerprint: "abc" });
    const back = fromProjectFile(text)!;
    expect(back.project).toEqual(p);
    expect(back.savedAt).toBe(5);
  });

  it("壞掉、別的格式、版本太新回 null", () => {
    expect(fromProjectFile("{")).toBeNull();
    expect(fromProjectFile(JSON.stringify({ format: "other", v: 1 }))).toBeNull();
    expect(fromProjectFile(JSON.stringify({ format: "wordblade-project", v: 99, project: p, media: {} }))).toBeNull();
  });

  it("搬家後找素材的順序：相對路徑（照新的專案位置）→ 原本的絕對路徑，不重複", () => {
    const text = toProjectFile(p, { projectDir: "D:\\videos\\MyTalk.wordblade", savedAt: 1 });
    const back = fromProjectFile(text)!;
    expect(relinkCandidates(back.refs[p.media[0].id], "E:\\backup\\MyTalk.wordblade")).toEqual(["E:\\backup\\clip-0.mp4", "D:\\videos\\clip-0.mp4"]);
    expect(relinkCandidates(back.refs[p.media[0].id], "D:\\videos\\MyTalk.wordblade")).toEqual(["D:\\videos\\clip-0.mp4"]);
  });
});

describe("relinkProject：開專案時逐支找回素材", () => {
  it("找到的換成新路徑、找不到的列為遺失（素材仍留在專案裡）", async () => {
    const p = makeProject();
    p.media = p.media.map((m, i) => ({ ...m, path: `D:/videos/clip-${i}.mp4` }));
    const text = toProjectFile(p, { projectDir: "D:/videos/MyTalk.wordblade", savedAt: 1, fingerprints: { [p.media[0].id]: "fp0" } });
    const { project, refs } = fromProjectFile(text)!;
    const asked: string[][] = [];
    const result = await relinkProject(project, refs, "E:/moved/MyTalk.wordblade", async (m, candidates, fp) => {
      asked.push([...candidates, fp ?? "-"]);
      return m.id === p.media[0].id ? { ...m, path: candidates[0] } : null;
    });
    expect(asked[0]).toEqual(["E:/moved/clip-0.mp4", "D:/videos/clip-0.mp4", "fp0"]);
    expect(result.project.media[0].path).toBe("E:/moved/clip-0.mp4");
    expect(result.missing).toEqual(p.media.slice(1).map((m) => m.id));
    expect(result.project.media).toHaveLength(p.media.length);
  });
});


// 遮罩取樣放進 .data\masks\（D41 P5，2026-11-01）：project.json 只留參照，SAM 的編碼內容不塞在專案檔裡。
describe("遮罩取樣放進 .data", () => {
  const mask = (id: string): MaskObject => ({
    id, mediaId: "m1", prompt: "face", label: "face 1", interval: 0.1,
    samples: [{ t: 1, box: [0, 0, 0.5, 0.5], mask: { x: 0, y: 0, w: 0.5, h: 0.5, cols: 2, rows: 2, payload: "RLE..." } }],
    effect: { kind: "mosaic", strength: 20 },
  } as MaskObject);

  it("拆出來：專案裡的取樣清空、記參照；檔案內容是取樣", () => {
    const p = { ...makeProject(), masks: [mask("k1")] };
    const { project, files } = externalizeMasks(p);
    expect(project.masks[0].samples).toEqual([]);
    expect(project.masks[0].samplesRef).toBe("masks/k1.json");
    expect(JSON.parse(files["masks/k1.json"])).toEqual(p.masks[0].samples);
    // 原本的專案不動
    expect(p.masks[0].samples).toHaveLength(1);
  });

  it("讀回：照參照讀檔接回取樣；讀不到的留空；舊專案（取樣直接在專案裡）照舊", async () => {
    const p = { ...makeProject(), masks: [mask("k1"), mask("k2"), mask("k3")] };
    const { project, files } = externalizeMasks({ ...p, masks: p.masks.slice(0, 2) });
    const withOld = { ...project, masks: [...project.masks, p.masks[2]] };
    const back = await internalizeMasks(withOld, async (rel) => (rel === "masks/k1.json" ? files[rel] : null));
    expect(back.masks[0].samples).toEqual(p.masks[0].samples);
    expect(back.masks[0].samplesRef).toBeUndefined();
    expect(back.masks[1].samples).toEqual([]);
    expect(back.masks[2].samples).toEqual(p.masks[2].samples);
  });

  it("檔名只用安全的 id（不能跳出 .data）", () => {
    const p = { ...makeProject(), masks: [mask("../../evil")] };
    expect(Object.keys(externalizeMasks(p).files)).toEqual(["masks/------evil.json"]);
  });
});
