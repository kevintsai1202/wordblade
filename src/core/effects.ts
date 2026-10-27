// 特效區段的編輯（spec §5.7、§4 Effect）：純函式，用 Immer 做結構共享；都可以復原（history 的 Edit）。
import { produce } from "immer";
import type { Effect, Plugin, Project, Seconds } from "./model";
import { roundTime } from "./time";

/** 特效最短長度（秒） */
const MIN_EFFECT: Seconds = 0.1;

/** 加一個特效，連同它用到的插件（已經有同 hash 的就不重複加）；id 重複時原樣回傳 */
export function addEffect(project: Project, effect: Effect, plugins: Plugin[]): Project {
  if (project.effects.some((e) => e.id === effect.id)) return project;
  return produce(project, (draft) => {
    draft.effects.push(effect);
    for (const p of plugins) if (!draft.plugins.some((x) => x.hash === p.hash)) draft.plugins.push(p);
  });
}

/** 對某個特效做修改；找不到原樣回傳 */
function editEffect(project: Project, id: string, change: (e: Effect) => void): Project {
  if (!project.effects.some((e) => e.id === id)) return project;
  return produce(project, (draft) => {
    change(draft.effects.find((e) => e.id === id)!);
  });
}

/** 移動特效：長度不變，起點不小於 0 */
export function moveEffect(project: Project, id: string, start: Seconds): Project {
  return editEffect(project, id, (e) => {
    const len = e.end - e.start;
    e.start = roundTime(Math.max(0, start));
    e.end = roundTime(e.start + len);
  });
}

/** 修邊：把起點（in）或終點（out）拖到 t；最短 0.1 秒、起點不小於 0 */
export function trimEffect(project: Project, id: string, edge: "in" | "out", t: Seconds): Project {
  return editEffect(project, id, (e) => {
    if (edge === "in") e.start = roundTime(Math.max(0, Math.min(t, e.end - MIN_EFFECT)));
    else e.end = roundTime(Math.max(t, e.start + MIN_EFFECT));
  });
}

/** 刪除特效（插件留在專案裡，之後可以再用） */
export function deleteEffect(project: Project, id: string): Project {
  if (!project.effects.some((e) => e.id === id)) return project;
  return produce(project, (draft) => {
    draft.effects = draft.effects.filter((e) => e.id !== id);
  });
}

/** 換掉特效的參數（目標框、色票、圖層與各層參數） */
export function setEffectParams(project: Project, id: string, params: Record<string, unknown>): Project {
  return editEffect(project, id, (e) => {
    e.params = params;
  });
}

/** 一個要畫的 2D 特效：區段內第幾格、區段長度 */
export interface EffectFrame {
  effectId: string;
  frame: number;
  duration: Seconds;
}

/** 時間 t 有效的 2D 特效（起點含、終點不含），依起點排序；frame＝區段內的格數（四捨五入，§5.1） */
export function effectPlan(project: Project, t: Seconds, fps: number): EffectFrame[] {
  return project.effects
    .filter((e) => e.kind === "anim2d" && t >= e.start && t < e.end)
    .sort((a, b) => a.start - b.start)
    .map((e) => ({ effectId: e.id, frame: Math.round((t - e.start) * fps), duration: roundTime(e.end - e.start) }));
}
