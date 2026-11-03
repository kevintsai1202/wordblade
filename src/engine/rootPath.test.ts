import { describe, expect, it } from "vitest";
import { commonFolder, pathUnderRoot } from "./rootPath";

// 網頁版授權資料夾（2026-11-01）：桌面版存的素材路徑，換成使用者授權的資料夾底下的相對路徑
describe("授權資料夾裡的相對路徑", () => {
  it("找到路徑裡和資料夾同名的那一層，取它後面的部分（取最後一個同名的）", () => {
    expect(pathUnderRoot("D:\\GitHub\\yt任務\\out\\a.mp4", "GitHub")).toEqual(["yt任務", "out", "a.mp4"]);
    expect(pathUnderRoot("D:\\GitHub\\07-projects.jpg", "github")).toEqual(["07-projects.jpg"]);
    expect(pathUnderRoot("/home/k/x/y/x/z.png", "x")).toEqual(["z.png"]);
  });

  it("路徑裡沒有那一層：null", () => {
    expect(pathUnderRoot("D:\\Other\\a.mp4", "GitHub")).toBeNull();
  });

  it("找不到的素材共同的上層資料夾（提示要授權哪裡）", () => {
    expect(commonFolder(["D:\\GitHub\\a.jpg", "D:\\GitHub\\yt\\b.mp4"])).toBe("D:\\GitHub");
    expect(commonFolder(["D:\\GitHub\\a.jpg"])).toBe("D:\\GitHub");
    expect(commonFolder(["D:\\a\\x.jpg", "E:\\b\\y.jpg"])).toBeNull();
    expect(commonFolder([])).toBeNull();
  });
});
