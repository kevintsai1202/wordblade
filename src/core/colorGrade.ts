// 色彩調整（P3；2026-11-02）：時間軸範圍內的影像圖層一起調亮度、對比、飽和度、色溫。純函式，預覽與匯出共用。
// 預設「整條」（end 不設＝到結尾）；有選範圍就只調那段。重疊時後加的蓋前面的。漣漪刪除／插入時範圍跟著移。
import { produce, type Draft } from "immer";
import type { ColorGrade, Project, Seconds } from "./model";
import { roundTime } from "./time";

/** 四個調整值（−1～1，0 是不變） */
export type GradeValues = Pick<ColorGrade, "brightness" | "contrast" | "saturation" | "temperature">;

/** 全部是 0（不調） */
export const NEUTRAL: GradeValues = { brightness: 0, contrast: 0, saturation: 0, temperature: 0 };

/** 是不是不調 */
export function isNeutral(v: GradeValues): boolean {
  return v.brightness === 0 && v.contrast === 0 && v.saturation === 0 && v.temperature === 0;
}

/** 時間 t 的調整值（後加的優先）；沒有或是不調就回 null */
export function gradeAt(project: Project, t: Seconds): GradeValues | null {
  const list = project.colorGrades;
  if (!list?.length) return null;
  for (let i = list.length - 1; i >= 0; i--) {
    const g = list[i];
    if (t >= g.start && (g.end === undefined || t < g.end)) return isNeutral(g) ? null : g;
  }
  return null;
}

/** 值夾在 −1～1 */
const clamp = (v: number) => Math.max(-1, Math.min(1, Number.isFinite(v) ? v : 0));

/** 新增或改一段（id 已存在就改它的值）；range 沒給＝整條 */
export function setColorGrade(project: Project, id: string, values: GradeValues, range?: { start: Seconds; end: Seconds } | null): Project {
  const v = { brightness: clamp(values.brightness), contrast: clamp(values.contrast), saturation: clamp(values.saturation), temperature: clamp(values.temperature) };
  return produce(project, (d) => {
    const list = (d.colorGrades ??= []);
    const old = list.find((g) => g.id === id);
    if (old) {
      Object.assign(old, v);
      return;
    }
    list.push(range && range.end > range.start ? { id, start: roundTime(range.start), end: roundTime(range.end), ...v } : { id, start: 0, ...v });
  });
}

/** 刪掉一段 */
export function deleteColorGrade(project: Project, id: string): Project {
  if (!project.colorGrades?.some((g) => g.id === id)) return project;
  return produce(project, (d) => { d.colorGrades = d.colorGrades!.filter((g) => g.id !== id); });
}

/** 漣漪刪除 [a, b)：範圍跟著往前移、被刪到的部分縮短，整段被刪光的拿掉（整條的不受影響） */
export function rippleGradesDelete(draft: Draft<Project>, a: Seconds, b: Seconds) {
  if (!draft.colorGrades) return;
  const d = b - a;
  /** 一個時間點刪掉 [a, b) 之後的位置 */
  const map = (t: Seconds) => (t <= a ? t : t >= b ? t - d : a);
  draft.colorGrades = draft.colorGrades.filter((g) => {
    if (g.end === undefined) {
      g.start = roundTime(map(g.start));
      return true;
    }
    const start = roundTime(map(g.start));
    const end = roundTime(map(g.end));
    if (end - start <= 1e-6) return false;
    g.start = start;
    g.end = end;
    return true;
  });
}

/** 漣漪插入：在 p 空出 d 秒；在 p 之後的範圍右移，跨在 p 上的延長 */
export function rippleGradesInsert(draft: Draft<Project>, p: Seconds, d: Seconds) {
  for (const g of draft.colorGrades ?? []) {
    if (g.start >= p) g.start = roundTime(g.start + d);
    if (g.end !== undefined && g.end > p) g.end = roundTime(g.end + d);
  }
}
