import { describe, expect, it } from "vitest";
import { makeProject } from "../core/fixtures";
import { toProjectFile } from "../core/projectFile";
import { loadSample, samplePath } from "./sample";

// 範例專案（spec §5.22）：project.json 裡的素材路徑是 sample/ 底下的相對路徑，載入時改到實際位置
// （網頁版 sample/...＝靜態網站網址；Windows 版是安裝資料夾裡的 sample\ 絕對路徑）。
function sampleText() {
  const p = makeProject();
  p.media = [
    { id: "v", name: "demo-2min.mp4", kind: "video", duration: 108, path: "sample/media/demo-2min.mp4" },
    { id: "w", name: "intro-music.wav", kind: "audio", duration: 8, path: "sample/media/intro-music.wav" },
  ];
  return toProjectFile(p, { projectDir: "", savedAt: 1 });
}

describe("samplePath", () => {
  it("網頁版：維持 sample/ 相對路徑；Windows 版：換成資料夾的絕對路徑（反斜線）", () => {
    expect(samplePath("sample/media/a.mp4", "sample")).toBe("sample/media/a.mp4");
    expect(samplePath("sample/media/a.mp4", "C:\\Program Files\\WordBlade\\sample")).toBe("C:\\Program Files\\WordBlade\\sample\\media\\a.mp4");
    expect(samplePath("other/a.mp4", "C:\\x\\sample")).toBe("other/a.mp4");
  });
});

describe("loadSample", () => {
  it("讀出專案並改好素材路徑；壞掉的檔回 null", () => {
    const p = loadSample(sampleText(), "D:\\app\\sample");
    expect(p?.media.map((m) => m.path)).toEqual(["D:\\app\\sample\\media\\demo-2min.mp4", "D:\\app\\sample\\media\\intro-music.wav"]);
    expect(loadSample("{", "sample")).toBeNull();
  });
});
