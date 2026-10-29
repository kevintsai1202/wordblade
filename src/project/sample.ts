// 範例專案（spec §5.22、D22）：預先算好的專案放在 public/sample/（project.json＋素材），網頁版從靜態網站讀、Windows 版打包在安裝資料夾。
// project.json 裡的素材路徑一律寫成 sample/ 底下的相對路徑，載入時依實際位置改寫。
import type { Project } from "../core/model";
import { fromProjectFile } from "../core/projectFile";

/** 素材路徑的前綴 */
const PREFIX = "sample/";

/** 一個素材路徑改到範例資料夾的實際位置：root 是 "sample"（網頁版）就不動；Windows 版換成 root 底下的絕對路徑 */
export function samplePath(path: string, root: string): string {
  if (!path.startsWith(PREFIX) || root === "sample") return path;
  return `${root.replace(/[\\/]+$/, "")}\\${path.slice(PREFIX.length).replace(/\//g, "\\")}`;
}

/** 讀範例專案的 project.json 並改好素材路徑；讀不出來回 null */
export function loadSample(text: string, root: string): Project | null {
  const parsed = fromProjectFile(text);
  if (!parsed) return null;
  const { project } = parsed;
  return { ...project, media: project.media.map((m) => (m.path ? { ...m, path: samplePath(m.path, root) } : m)) };
}
