// 專案資料夾的存與開（spec §5.13、D41）：存的時候補上素材指紋（算過的記住）、開的時候逐支找回素材、最近開啟清單、匯出預設位置。
// 平台相關的事（寫檔、找檔、算指紋）由呼叫端注入（Engine），這裡可以單元測試。
import type { Media, Project } from "../core/model";
import { fromProjectFile, joinPath, relinkProject, toProjectFile } from "../core/projectFile";
import type { ProjectLocation } from "../engine/Engine";

/** 最近開啟的一筆 */
export interface RecentProject extends ProjectLocation {
  openedAt: number;
}

/** 最近開啟最多幾筆 */
const MAX_RECENT = 8;
/** 最近開啟存在 localStorage 的鍵 */
export const RECENT_KEY = "wordblade.recentProjects";

/** 專案 → project.json 的文字；有路徑但還沒算過指紋的素材先算（記進 cache，同一支只算一次） */
export async function projectText(
  project: Project,
  location: ProjectLocation,
  cache: Map<string, string>,
  fingerprint: (media: Media) => Promise<string | undefined>,
  savedAt: number,
): Promise<string> {
  for (const m of project.media) {
    const key = `${m.id}|${m.path ?? ""}`;
    if (!m.path || cache.has(key)) continue;
    const fp = await fingerprint(m);
    if (fp) cache.set(key, fp);
  }
  const fingerprints: Record<string, string> = {};
  for (const m of project.media) {
    const fp = cache.get(`${m.id}|${m.path ?? ""}`);
    if (fp) fingerprints[m.id] = fp;
  }
  return toProjectFile(project, { projectDir: location.dir, savedAt, fingerprints });
}

/** 開專案時找不到的素材（重新連結用：id、顯示名稱、存檔時的指紋） */
export interface MissingMedia {
  id: string;
  name: string;
  fingerprint?: string;
}

/** 找素材的平台函式（Engine.locateMedia） */
type Locate = (media: Media, candidates: string[], fingerprint?: string) => Promise<Media | null>;

/** 開專案：讀 project.json、逐支找回素材；回傳專案與找不到的素材，檔案壞掉回錯誤訊息 */
export async function loadProjectText(
  text: string,
  location: ProjectLocation,
  locate: Locate,
): Promise<{ project: Project; missing: MissingMedia[]; savedAt: number } | { error: string }> {
  const parsed = fromProjectFile(text);
  if (!parsed) return { error: `This folder's project.json can't be read (damaged, or made by a newer WordBlade).` };
  const { project, missing } = await relinkProject(parsed.project, parsed.refs, location.dir, locate);
  return {
    project,
    savedAt: parsed.savedAt,
    missing: missing.map((id) => ({ id, name: project.media.find((m) => m.id === id)?.name ?? id, fingerprint: parsed.refs[id]?.fingerprint })),
  };
}

/**
 * 重新連結：使用者替 target 選了 picked，直接採用（使用者自己選的，不比指紋）；
 * 其他遺失的素材多半是一起搬走的，用原檔名在 picked 的同一個資料夾找（比指紋）。回傳找到的 id 與新路徑。
 */
export async function relinkMissing(target: Media, picked: string, media: Media[], missing: MissingMedia[], locate: Locate): Promise<{ id: string; path: string }[]> {
  const first = await locate(target, [picked]);
  if (!first?.path) return [];
  const found = [{ id: target.id, path: first.path }];
  for (const miss of missing) {
    const m = media.find((x) => x.id === miss.id);
    if (!m || m.id === target.id || !m.path) continue;
    const base = m.path.split(/[\\/]/).pop() ?? m.name;
    const hit = await locate(m, [joinPath(picked, `../${base}`)], miss.fingerprint);
    if (hit?.path) found.push({ id: m.id, path: hit.path });
  }
  return found;
}

/** 最近開啟加一筆：最新的在前、同一個資料夾只留一筆、最多 8 筆 */
export function pushRecent(list: RecentProject[], location: ProjectLocation, openedAt: number): RecentProject[] {
  const key = location.dir.toLowerCase();
  return [{ ...location, openedAt }, ...list.filter((r) => r.dir.toLowerCase() !== key)].slice(0, MAX_RECENT);
}

/** 匯出預設位置：專案資料夾旁邊（同一層）的 <專案名>.<副檔名>；沒有開專案時只給檔名 */
export function exportPathFor(location: ProjectLocation | null, ext: string): string {
  return location ? joinPath(location.dir, `../${location.name}.${ext}`) : `wordblade-export.${ext}`;
}
