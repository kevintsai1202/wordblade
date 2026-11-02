// 範例專案（spec §5.22、D22）：預先算好的專案放在 public/<範例 id>/（project.json＋素材），網頁版從靜態網站讀、Windows 版打包在安裝資料夾。
// 兩個範例（2026-11-02）：sample＝AI 導演（剪輯、改字、遮罩、放大、字幕），sample-effects＝各種特效（Vibe 2D／3D、3D 場景、範本、轉場、色彩、片頭、配樂）。
// project.json 裡的素材路徑一律寫成 <範例 id>/ 底下的相對路徑，載入時依實際位置改寫。
import type { Project } from "../core/model";
import { fromProjectFile } from "../core/projectFile";

/** 範例 id（也是資料夾名稱） */
export type SampleId = "sample" | "sample-effects";

/** 可以開的範例：id、按鈕文字、說明 */
export const SAMPLES: { id: SampleId; label: string; title: string }[] = [
  { id: "sample", label: "Try the sample project", title: "Open a ready-made 2-minute sample edited by the AI director: transcript, cuts, fixes, masks and zooms are already in it (no token needed)" },
  { id: "sample-effects", label: "Try the effects sample", title: "Open the same 2-minute video dressed with every kind of effect: Vibe 2D/3D, 3D scenes, templates, transitions, color, intro and music (no token needed)" },
];

/** 一個素材路徑改到範例資料夾的實際位置：root 就是資料夾名稱（網頁版）就不動；Windows 版換成 root 底下的絕對路徑 */
export function samplePath(path: string, root: string, dir: SampleId = "sample"): string {
  const prefix = `${dir}/`;
  if (!path.startsWith(prefix) || root === dir) return path;
  return `${root.replace(/[\\/]+$/, "")}\\${path.slice(prefix.length).replace(/\//g, "\\")}`;
}

/** 讀範例專案的 project.json 並改好素材路徑；讀不出來回 null */
export function loadSample(text: string, root: string, dir: SampleId = "sample"): Project | null {
  const parsed = fromProjectFile(text);
  if (!parsed) return null;
  const { project } = parsed;
  return { ...project, media: project.media.map((m) => (m.path ? { ...m, path: samplePath(m.path, root, dir) } : m)) };
}
