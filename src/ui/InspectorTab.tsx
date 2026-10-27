// Inspector 頁籤（spec §5.13 ③屬性）：選取的特效的設定——目標框，以及各圖層插件的參數。
// 表單依插件的參數定義（原專案 anim_runtime 的參數型別）自動產生；每次改動是一筆可復原的編輯（setEffectParams）。
// 文字與數字在離開欄位或按 Enter 時才送出，避免打一個字就留一筆歷史。
import { useEffect, useState, type Dispatch } from "react";
import manifest from "../anim/anim_api_manifest.json";
import { displayOf, type Component, type ParamDef } from "../anim/library";
import type { Effect, Project } from "../core/model";
import type { Action } from "./state";

/** 方向參數的選項與字型參數的選項（原專案 API 說明裡的列舉） */
const DIRECTIONS: string[] = manifest.params.directions;
const FONTS: string[] = manifest.params.fonts;

/** 目標框（0～1，中心＋寬高） */
interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** 特效的圖層（存在 Effect.params.layers） */
interface Layer {
  component: string;
  params: Record<string, unknown>;
}

/** 文字或數字欄位：本地暫存，離開或 Enter 才送出 */
function CommitInput({ value, type, onCommit, ...rest }: { value: string | number; type: "text" | "number"; onCommit: (v: string) => void } & Record<string, unknown>) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => { if (draft !== String(value)) onCommit(draft); };
  return <input type={type} value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") commit(); }} {...rest} />;
}

/** 一個參數的編輯欄位 */
function ParamField({ name, def, label, labels, value, onChange }: { name: string; def: ParamDef; label: string; labels?: string[]; value: unknown; onChange: (v: unknown) => void }) {
  const v = value ?? def.default;
  let field;
  switch (def.type) {
    case "enum":
    case "direction":
    case "font": {
      const values = def.type === "enum" ? def.values ?? [] : def.type === "direction" ? DIRECTIONS : FONTS;
      field = (
        <select value={String(v)} onChange={(e) => onChange(e.target.value)}>
          {values.map((x, i) => <option key={x} value={x}>{(def.type === "enum" ? labels?.[i] : undefined) ?? x}</option>)}
        </select>
      );
      break;
    }
    case "boolean":
      field = <input type="checkbox" checked={Boolean(v)} onChange={(e) => onChange(e.target.checked)} />;
      break;
    case "color":
      field = <input type="color" defaultValue={String(v)} key={String(v)} onBlur={(e) => { if (e.target.value !== v) onChange(e.target.value); }} />;
      break;
    case "number":
    case "duration":
      field = <CommitInput type="number" value={Number(v)} min={def.min} max={def.max} step={def.step ?? (def.type === "duration" ? 0.1 : 1)} onCommit={(x) => onChange(Math.min(def.max ?? Infinity, Math.max(def.min ?? -Infinity, Number(x))))} />;
      break;
    case "text":
      field = <CommitInput type="text" value={String(v)} maxLength={def.maxLength} onCommit={onChange} />;
      break;
    default:
      field = <span className="muted">{JSON.stringify(v)}</span>;
  }
  return (
    <label className="param-field" data-param={name}>
      <span>{label}</span>
      {field}
    </label>
  );
}

/** Inspector 頁籤 */
export function InspectorTab({ project, effectId, dispatch }: { project: Project; effectId: string | null; dispatch: Dispatch<Action> }) {
  const effect: Effect | undefined = project.effects.find((e) => e.id === effectId);
  if (!effect) return <p className="muted placeholder">Select an effect on the timeline to edit it.</p>;
  if (effect.kind !== "anim2d") return <Inspector3D project={project} effect={effect} dispatch={dispatch} />;
  const box = effect.params.box as Box;
  const layers = (effect.params.layers ?? []) as Layer[];

  /** 送出新的特效參數（一筆可復原的編輯） */
  const update = (params: Record<string, unknown>) => dispatch({ type: "commit", edits: [{ kind: "setEffectParams", effectId: effect.id, params }] });
  const setBox = (key: keyof Box, value: number) => update({ ...effect.params, box: { ...box, [key]: Math.min(1, Math.max(key === "w" || key === "h" ? 0.01 : 0, value)) } });
  const setParam = (i: number, key: string, value: unknown) =>
    update({ ...effect.params, layers: layers.map((l, j) => (j === i ? { ...l, params: { ...l.params, [key]: value } } : l)) });

  return (
    <div className="inspector" data-testid="inspector">
      <h3 className="section-title">{String(effect.params.title ?? "Effect")}</h3>
      <p className="muted">{effect.start.toFixed(2)}s – {effect.end.toFixed(2)}s · drag the box on the preview to move it</p>
      <fieldset className="param-group">
        <legend>Target box</legend>
        {(["cx", "cy", "w", "h"] as const).map((k) => (
          <label key={k} className="param-field" data-param={`box.${k}`}>
            <span>{{ cx: "Center X", cy: "Center Y", w: "Width", h: "Height" }[k]}</span>
            <CommitInput type="number" value={Number(box[k].toFixed(3))} step={0.01} min={0} max={1} onCommit={(x) => setBox(k, Number(x))} />
          </label>
        ))}
      </fieldset>
      {layers.map((layer, i) => {
        const plugin = project.plugins.find((p) => p.hash === layer.component);
        if (!plugin) return <p key={i} className="error">Missing plugin for layer {i + 1}</p>;
        const component = plugin.component as Component;
        const display = displayOf(component);
        return (
          <fieldset key={i} className="param-group">
            <legend>{display.name}</legend>
            {Object.entries(component.params ?? {}).map(([key, def]) => (
              <ParamField key={key} name={key} def={def} label={display.params[key]?.label ?? key} labels={display.params[key]?.labels} value={layer.params[key]} onChange={(v) => setParam(i, key, v)} />
            ))}
          </fieldset>
        );
      })}
    </div>
  );
}

/** 3D 特效的設定：依 3D 元件的參數定義產生表單；關鍵幀這類複雜參數先唯讀顯示（用「用說的」或範本改） */
function Inspector3D({ project, effect, dispatch }: { project: Project; effect: Effect; dispatch: Dispatch<Action> }) {
  const plugin = project.plugins.find((p) => p.hash === effect.pluginId);
  const component = plugin?.component as { name?: string; params?: Record<string, ParamDef> } | undefined;
  const values = ((effect.params as { params?: Record<string, unknown> }).params ?? {}) as Record<string, unknown>;
  /** 改一個參數（一筆可復原的編輯） */
  const set = (key: string, value: unknown) =>
    dispatch({ type: "commit", edits: [{ kind: "setEffectParams", effectId: effect.id, params: { ...effect.params, params: { ...values, [key]: value } } }] });
  return (
    <div className="inspector" data-testid="inspector">
      <h3 className="section-title">{String(effect.params.title ?? component?.name ?? "3D effect")}</h3>
      <p className="muted">{effect.start.toFixed(2)}s – {effect.end.toFixed(2)}s · {effect.kind === "scene3d" ? "3D scene (replaces the main track)" : "3D overlay"}</p>
      <fieldset className="param-group">
        <legend>{component?.name ?? "Settings"}</legend>
        {Object.entries(component?.params ?? {}).map(([key, def]) =>
          ["keys", "float"].includes(def.type)
            ? <label key={key} className="param-field" data-param={key}><span>{def.label ?? key}</span><code className="muted">{JSON.stringify(values[key] ?? def.default)?.slice(0, 120)}</code></label>
            : <ParamField key={key} name={key} def={def} label={def.label ?? key} labels={def.labels} value={values[key]} onChange={(v) => set(key, v)} />)}
      </fieldset>
    </div>
  );
}
