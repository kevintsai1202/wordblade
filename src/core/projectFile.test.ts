import { describe, expect, it } from "vitest";
import { makeProject } from "./fixtures";
import { fromProjectFile, joinPath, relativePath, relinkCandidates, relinkProject, toProjectFile } from "./projectFile";

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

