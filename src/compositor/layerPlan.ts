// 每一格的疊放順序（spec §5.10）：純函式，預覽與匯出共用（D24）。
// 由下到上：V1 主軌 → 3D 場景（scene3d：拿 V1 當格畫面當貼圖、畫滿版，蓋住 V1）→ V2 以上疊加軌 → 2D／3D 插件（依起點）。
// 字幕之後在合成器最上層另外疊（JASSUB）。
import type { Project, Seconds } from "../core/model";
import { roundTime } from "../core/time";
import { framePlan, type VideoLayer } from "./framePlan";

/** 一層 */
export type PlanItem =
  | { kind: "video"; layer: VideoLayer }
  /** 3D 場景：蓋住 V1，下層畫面只用 V1 */
  | { kind: "scene"; effectId: string; frame: number; duration: Seconds }
  /** 疊加的插件（anim2d、anim3d）：下層畫面是到這一層為止的合成結果 */
  | { kind: "overlay"; effectId: string; frame: number; duration: Seconds };

/** 時間 t 這一格要依序畫的圖層 */
export function layerPlan(project: Project, t: Seconds, fps: number): PlanItem[] {
  const v1 = [...project.tracks].filter((tr) => tr.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  const trackOf = new Map(project.clips.map((c) => [c.id, c.trackId]));
  const layers = framePlan(project, t);
  /** 屬於 V1 的圖層（轉場的純色圖層也算 V1） */
  const onV1 = (l: (typeof layers)[number]) => !!l.solid || trackOf.get(l.clipId) === v1;
  const active = project.effects.filter((e) => t >= e.start && t < e.end).sort((a, b) => a.start - b.start);
  /** 特效 → 一層（區段內的格數四捨五入，§5.1） */
  const item = <K extends "scene" | "overlay">(kind: K, e: (typeof active)[number]) =>
    ({ kind, effectId: e.id, frame: Math.round((t - e.start) * fps), duration: roundTime(e.end - e.start) }) as const;
  return [
    ...layers.filter(onV1).map((layer) => ({ kind: "video" as const, layer })),
    ...active.filter((e) => e.kind === "scene3d").map((e) => item("scene", e)),
    ...layers.filter((l) => !onV1(l)).map((layer) => ({ kind: "video" as const, layer })),
    ...active.filter((e) => e.kind === "anim2d" || e.kind === "anim3d").map((e) => item("overlay", e)),
  ];
}
