// 自動存檔（spec §5.13 P0「每次編輯後 2 秒寫入」的第一步）：專案存在這台電腦（localStorage），下次開啟時提示還原。
// 正式的專案檔（存檔／開啟 .wordblade）與 IndexedDB（大專案）之後再做。
import type { Project } from "./model";

/** 存檔格式版本 */
const VERSION = 1;
/** localStorage 的鍵 */
export const SESSION_KEY = "wordblade.session";

/** 專案 → 存檔字串 */
export function serializeSession(project: Project, savedAt: number): string {
  return JSON.stringify({ v: VERSION, savedAt, project });
}

/** 存檔字串 → 專案與存檔時間；沒有、壞掉或版本不對回 null */
export function restoreSession(raw: string | null): { project: Project; savedAt: number } | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as { v?: number; savedAt?: number; project?: Project };
    const p = data.project;
    if (data.v !== VERSION || !p || !Array.isArray(p.clips) || !Array.isArray(p.media) || !Array.isArray(p.tracks)) return null;
    return { project: p, savedAt: Number(data.savedAt) || 0 };
  } catch {
    return null;
  }
}

/**
 * 要不要存：有素材才存；剛載入的示範專案（還沒編輯過）不存，免得蓋掉使用者上次的工作。
 * edits：復原歷史裡有幾步；demo：目前是不是示範專案。
 */
export function shouldSave(project: Project, edits: number, demo: boolean): boolean {
  if (!project.media.length) return false;
  return !demo || edits > 0;
}
