// 內建 3D 插件與範本（spec §5.8）。插件程式在 builtins/*.js，跑在 3D 沙盒（threeHost）裡。
// 3D 插件的元件格式：{id, kind: "3d", effectKind（scene3d 蓋住 V1／anim3d 疊在上面）, name, description, params（同 2D 的參數定義）, code}；
// 雜湊是穩定 JSON 的 SHA-256（2D 的雜湊由直譯器算，3D 不經直譯器，在主程式算）。
import type { Effect, Plugin } from "../core/model";
import deskScreenCode from "./builtins/deskScreen.js?raw";
import floatingBoardCode from "./builtins/floatingBoard.js?raw";
import mascotCode from "./builtins/mascot.js?raw";
import boardGeometryCode from "./boardGeometry.js?raw";
import plane3dMathCode from "./vendor/plane3d_math.js?raw";
import cameraPathCode from "./cameraPath.js?raw";

/** 板子姿勢關鍵幀（原專案字導字演的格式；角度用度、size＝板寬佔畫面寬、px／py 以畫面寬高為 1） */
export interface BoardKey {
  anchor: "start" | "end";
  t: number;
  rx: number;
  ry: number;
  rz: number;
  size: number;
  px: number;
  py: number;
  ease?: "inOut" | "linear" | "in" | "out";
}

/** 一個關鍵幀（沒給的用滿版平面的值，同原專案 p3Key） */
function key(k: Partial<BoardKey>): BoardKey {
  return { anchor: "start", t: 0, rx: 0, ry: 0, rz: 0, size: 1, px: 0, py: 0, ease: "inOut", ...k };
}

/** 3D 元件 */
export interface Component3D {
  id: string;
  kind: "3d";
  effectKind: "scene3d" | "anim3d";
  name: string;
  description: string;
  params: Record<string, { type: string; default?: unknown; label?: string; min?: number; max?: number; step?: number; values?: string[]; labels?: string[] }>;
  code: string;
}

/** 內建 3D 元件 */
export const COMPONENTS_3D: Component3D[] = [
  {
    id: "desk-screen", kind: "3d", effectKind: "scene3d", name: "Screen in a scene",
    description: "The video plays on a screen in a 3D scene (desk, classroom board or studio); starts and ends full-frame so it cuts in seamlessly",
    params: {
      scene: { type: "enum", values: ["desk", "classroom", "studio"], labels: ["Wooden desk", "Classroom board", "Studio"], default: "desk", label: "Scene" },
      motion: { type: "enum", values: ["reveal", "push", "orbit"], labels: ["Pull back and return", "Slow push in", "Orbit"], default: "reveal", label: "Camera (no keyframes)" },
      tilt: { type: "number", min: 0, max: 20, step: 1, default: 7, label: "Screen tilt (°)" },
      ramp: { type: "duration", min: 0.3, max: 3, default: 1.2, label: "In/out (sec)" },
    },
    // 鏡頭關鍵幀的內插串在插件前面
    code: `${cameraPathCode}
;
${deskScreenCode}`,
  },
  {
    id: "floating-board", kind: "3d", effectKind: "scene3d", name: "Floating board",
    description: "The video becomes a board that turns, pushes in and pulls back in space; starts and ends full-frame",
    params: {
      keys: { type: "keys", default: [key({})], label: "Board keyframes" },
      float: { type: "float", default: null, label: "Gentle sway" },
      edges: { type: "boolean", default: true, label: "Return to full frame at both ends" },
      background: { type: "enum", values: ["studio", "grid", "blur", "color"], labels: ["Studio", "Tech grid", "Blurred video", "Solid color"], default: "studio", label: "Background" },
      color: { type: "color", default: "#202020", label: "Background color" },
      shadow: { type: "number", min: 0, max: 1, step: 0.05, default: 0.55, label: "Shadow" },
    },
    // 原專案的姿勢數學與板子幾何串在插件前面，一起送進沙盒 Worker
    code: `${plane3dMathCode}
;
${boardGeometryCode}
;
${floatingBoardCode}`,
  },
  {
    id: "mascot", kind: "3d", effectKind: "anim3d", name: "Mascot",
    description: "A little 3D character walks in, stops next to the target box and waves or points at it",
    params: {
      action: { type: "enum", values: ["point", "wave"], labels: ["Point at the box", "Wave"], default: "point", label: "Action" },
      from: { type: "enum", values: ["left", "right"], labels: ["Left", "Right"], default: "left", label: "Walks in from" },
      color: { type: "color", default: "#ffb020", label: "Color" },
      height: { type: "number", min: 0.15, max: 0.7, step: 0.05, default: 0.35, label: "Height (of frame)" },
      walk: { type: "duration", min: 0.3, max: 4, default: 1.6, label: "Walk time (sec)" },
    },
    code: mascotCode,
  },
];

/** 3D 範本（加到時間軸的預設長度與參數） */
export interface Template3D {
  id: string;
  title: string;
  name: string;
  componentId: string;
  params: Record<string, unknown>;
  duration: number;
}

export const TEMPLATES_3D: Template3D[] = [
  // 板子的 5 個運鏡範本（原專案 plane3d.js 的 P3_TEMPLATES，全部錨定在頭或尾，區段變長變短都維持速度）
  { id: "board-swing-in", title: "Swing in", name: "Floating board — swings in from the side", componentId: "floating-board", params: { keys: [key({ ry: 55, size: 0.55, px: 0.12 }), key({ t: 1.5, size: 0.82 })], float: null }, duration: 5 },
  { id: "board-top-push", title: "Top push", name: "Floating board — tilts up and pushes in", componentId: "floating-board", params: { keys: [key({ rx: 50, size: 0.5 }), key({ t: 2, rx: 8, size: 0.85 })], float: null }, duration: 5 },
  { id: "board-float", title: "Float", name: "Floating board — gentle sway", componentId: "floating-board", params: { keys: [key({ size: 0.8 })], float: { rx: 3, ry: 6, period: 4 } }, duration: 5 },
  { id: "board-pull-back", title: "Pull back", name: "Floating board — pulls back and tilts", componentId: "floating-board", params: { keys: [key({ size: 1 }), key({ t: 2, rx: 10, size: 0.6 })], float: null }, duration: 5 },
  { id: "board-swing-out", title: "Swing out", name: "Floating board — swings out at the end", componentId: "floating-board", params: { keys: [key({ anchor: "end", t: 1.5, size: 0.82 }), key({ anchor: "end", t: 0, ry: -55, size: 0.55, px: -0.12 })], float: null }, duration: 5 },
  { id: "mascot-point", title: "Mascot points", name: "Mascot walks in and points at the box", componentId: "mascot", params: { action: "point" }, duration: 4 },
  { id: "mascot-wave", title: "Mascot waves", name: "Mascot walks in and waves", componentId: "mascot", params: { action: "wave", from: "right" }, duration: 4 },
  { id: "desk-reveal", title: "Desk screen", name: "Screen on a desk — pull back and return", componentId: "desk-screen", params: { motion: "reveal" }, duration: 6 },
  { id: "desk-orbit", title: "Desk orbit", name: "Screen on a desk — orbit", componentId: "desk-screen", params: { motion: "orbit" }, duration: 6 },
  { id: "classroom-board", title: "Classroom board", name: "The video on a classroom blackboard", componentId: "desk-screen", params: { scene: "classroom", motion: "push", tilt: 0 }, duration: 6 },
  { id: "studio-screen", title: "Studio screen", name: "The video on a screen in a studio", componentId: "desk-screen", params: { scene: "studio", motion: "reveal" }, duration: 6 },
];

/** 物件的穩定 JSON（鍵排序） */
function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableJson((v as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** 3D 元件的雜湊（SHA-256 前 32 個十六進位字） */
export async function hash3D(component: Record<string, unknown>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(stableJson(component)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/** 內建 3D 插件（元件 id → 插件） */
let builtins3D: Promise<Map<string, Plugin>> | null = null;
export function builtinPlugins3D(): Promise<Map<string, Plugin>> {
  if (!builtins3D) {
    builtins3D = Promise.all(COMPONENTS_3D.map(async (c) => [c.id, { hash: await hash3D(c as unknown as Record<string, unknown>), kind: "3d", source: "builtin", component: c as unknown as Record<string, unknown> }] as const))
      .then((entries) => new Map(entries as [string, Plugin][]));
  }
  return builtins3D;
}

/** 3D 範本 → 時間軸特效（參數＝元件預設值＋範本的值） */
export function template3DEffect(template: Template3D, plugin: Plugin, id: string, start: number, duration: number = template.duration): Effect {
  const component = plugin.component as unknown as Component3D;
  const defaults = Object.fromEntries(Object.entries(component.params).map(([k, d]) => [k, d.default]));
  return {
    id, kind: component.effectKind, start, end: start + duration, pluginId: plugin.hash, anchorIds: [],
    params: {
      title: template.title, template: template.id, params: { ...defaults, ...template.params },
      // 疊加的 3D 特效（吉祥物）有目標框，和 2D 特效一樣可以在預覽上拖
      ...(component.effectKind === "anim3d" ? { box: { cx: 0.6, cy: 0.45, w: 0.25, h: 0.25 } } : {}),
    },
  };
}
