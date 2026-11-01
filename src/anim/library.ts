// 內建 2D 元件庫與範本（spec §5.7 範本；沿用原專案 anim-library.json，見 vendor/ORIGIN.md）。
// 介面是英文：元件本身維持原樣（原專案的驗證有長度上限，雜湊也涵蓋這些欄位），英文名稱、說明、參數標籤由 displayOf 給介面用；
// 只有文字參數的中文預設值換成英文（使用者會直接看到它畫在畫面上）。
// 這裡只處理資料；元件程式碼的驗證、雜湊、執行都在沙盒裡（sandboxHost）。
import type { Effect } from "../core/model";
import zh from "./anim-library.json";
import en from "./anim-library.en.json";

/** 元件（原專案格式；code 已接成字串） */
export type Component = Record<string, unknown> & { id: string; kind: "visual" | "sound"; name: string; params: Record<string, ParamDef> };

/** 參數定義（原專案 anim_runtime 的 8 種內建型別：number、enum、color、boolean、direction、duration、text、font） */
export interface ParamDef {
  type: string;
  default?: unknown;
  label?: string;
  min?: number;
  max?: number;
  step?: number;
  values?: string[];
  labels?: string[];
  maxLength?: number;
  role?: string;
  /** texture 參數收哪一種（材質庫的 kind）：texture＝可平鋪的材質，background＝3D 背景 */
  kind?: "texture" | "background";
}

/** 範本：一組圖層（元件＋參數）、預設目標框、音效（加進時間軸時跟著特效走，§5.15） */
export interface Template {
  id: string;
  name: string;
  title: string;
  box?: { w: number; h: number };
  layers: { component: string; params: Record<string, unknown> }[];
  sounds?: { component: string; params: Record<string, unknown>; at: number }[];
}

/** 文字參數的英文預設值（原專案的預設是中文） */
const EN_TEXT_DEFAULTS: Record<string, Record<string, string>> = {
  label: { text: "Here" },
  title: { text: "Key point!" },
};

type Translation = { name?: string; title?: string; description?: string; params?: Record<string, { label?: string; labels?: string[] }> };

/** 元件：接起程式碼、文字參數預設值換成英文 */
function prepare(raw: Record<string, unknown>): Component {
  const c = structuredClone(raw) as Component;
  if (Array.isArray(c.code)) c.code = (c.code as string[]).join("\n");
  for (const [key, def] of Object.entries(c.params ?? {})) {
    const text = EN_TEXT_DEFAULTS[c.id]?.[key];
    if (text !== undefined) def.default = text;
  }
  return c;
}

const enComponents = (en as { components: Record<string, Translation> }).components;
const enTemplates = (en as { templates: Record<string, Translation> }).templates;

/** 內建元件（視覺＋音效） */
export const COMPONENTS: Component[] = (zh as { components: Record<string, unknown>[] }).components.map(prepare);

/** 介面顯示用的英文：名稱、說明、參數標籤（沒有翻譯的用元件原本的） */
export function displayOf(component: Component): { name: string; description: string; params: Record<string, { label: string; labels?: string[] }> } {
  const t = enComponents[component.id];
  const params: Record<string, { label: string; labels?: string[] }> = {};
  for (const [key, def] of Object.entries(component.params ?? {})) {
    params[key] = { label: t?.params?.[key]?.label ?? def.label ?? key, labels: t?.params?.[key]?.labels ?? def.labels };
  }
  return { name: t?.name ?? component.name, description: t?.description ?? String(component.description ?? ""), params };
}

/** 內建範本（名稱換成英文） */
export const TEMPLATES: Template[] = (zh as { templates: Template[] }).templates.map((t) => ({ ...t, name: enTemplates[t.id]?.name ?? t.name, title: enTemplates[t.id]?.title ?? t.title }));

/** 範本加到時間軸時的預設長度（秒；原專案的範本沒有長度） */
export const DEFAULT_EFFECT_SECONDS = 2.5;

/**
 * 範本 → 時間軸上的 2D 特效。hashOf：元件 id → 沙盒算出的雜湊（圖層用雜湊指到元件）。
 * 目標框預設在畫面中央、大小用範本的；音效跟著特效走（元件換成雜湊，預覽與匯出混進聲音，§5.15）。
 */
export function templateEffect(template: Template, hashOf: (componentId: string) => string, id: string, start: number, duration = DEFAULT_EFFECT_SECONDS): Effect {
  const box = { cx: 0.5, cy: 0.5, w: template.box?.w ?? 0.3, h: template.box?.h ?? 0.2 };
  const layers = template.layers.map((l) => ({ component: hashOf(l.component), params: { ...l.params } }));
  return {
    id, kind: "anim2d", start, end: start + duration, pluginId: layers[0]?.component ?? "", anchorIds: [],
    params: { template: template.id, title: template.title, box, layers,
      sounds: (template.sounds ?? []).map((s) => ({ component: hashOf(s.component), params: { ...s.params }, at: s.at })) },
  };
}
