// Inspector 頁籤（spec §5.13 ③屬性）：選取的特效的設定——目標框，以及各圖層插件的參數。
// 表單依插件的參數定義（原專案 anim_runtime 的參數型別）自動產生；每次改動是一筆可復原的編輯（setEffectParams）。
// 文字與數字在離開欄位或按 Enter 時才送出，避免打一個字就留一筆歷史。
import { useEffect, useState, type Dispatch } from "react";
import { soundGain } from "../anim/effectSound";
import { GatewayClient, GatewayError, loadSettings } from "../ai/gateway";
import { runPlane3d, type BoardParams } from "../ai/plane3d";
import { captureFrame } from "./capture";
import manifest from "../anim/anim_api_manifest.json";
import { displayOf, type Component, type ParamDef } from "../anim/library";
import type { CameraKey, Clip, Effect, Project, TextureAsset, TransitionKind } from "../core/model";
import { TRANSITION_DEFAULT, TRANSITION_MAX, TRANSITION_MIN } from "../core/transitions";
import type { LayerFill, TextureRef } from "../anim/textureRefs";
import { MAX_SPEED, MIN_SPEED } from "../core/speed";
import { clipEnd } from "../core/timeline";
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

/** 材質下拉選「產生新的」的選項值 */
const NEW_TEXTURE = "__new";

/** 材質庫的項目 → 存進特效參數的引用（spec §5.12；顏色圖、法線圖、平鋪倍數與法線強度跟著項目目前的值） */
function refOf(t: TextureAsset): TextureRef {
  return { textureId: t.id, color: t.colorMediaId, ...(t.normalMediaId ? { normal: t.normalMediaId } : {}), repeat: t.repeat, normalStrength: t.normalStrength };
}

/**
 * 一個參數的編輯欄位。texture 型別（P1-14）要材質庫的項目（textures）與「產生新的」的動作（onNewTexture：切到 Textures 頁籤）。
 */
function ParamField({ name, def, label, labels, value, onChange, textures = [], onNewTexture }: { name: string; def: ParamDef; label: string; labels?: string[]; value: unknown; onChange: (v: unknown) => void; textures?: TextureAsset[]; onNewTexture?: () => void }) {
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
    case "texture": {
      // 下拉：預設（程式畫的）／材質庫裡同種類的項目（依名字）／產生新的；選了項目就寫入材質引用
      const ref = v as TextureRef | null;
      const options = textures.filter((t) => t.kind === (def.kind ?? "texture"));
      field = (
        <select data-testid="param-texture" value={ref?.textureId ?? ""}
          onChange={(e) => {
            if (e.target.value === NEW_TEXTURE) { onNewTexture?.(); return; }
            const picked = options.find((t) => t.id === e.target.value);
            onChange(picked ? refOf(picked) : null);
          }}>
          <option value="">Default</option>
          {options.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          <option value={NEW_TEXTURE}>Generate a new one…</option>
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
export function InspectorTab({ project, effectId, clipId = null, playhead = 0, dispatch, preview, onPreview, onOpenTab }: {
  project: Project;
  effectId: string | null;
  /** 選取的片段（沒有選特效時顯示片段屬性：變速） */
  clipId?: string | null;
  /** 播放頭（時間軸秒數）：新增鏡頭關鍵幀時放在這個時間 */
  playhead?: number;
  dispatch: Dispatch<Action>;
  /** AI 預覽中的設定（還沒寫進專案） */
  preview: { effectId: string; params: Record<string, unknown> } | null;
  onPreview: (p: { effectId: string; params: Record<string, unknown> } | null) => void;
  /** 切到右側面板的某個子頁籤（材質下拉的「產生新的」去 Textures） */
  onOpenTab?: (tab: string) => void;
}) {
  const effect: Effect | undefined = project.effects.find((e) => e.id === effectId);
  if (!effect) {
    const clip = project.clips.find((c) => c.id === clipId);
    if (clip) return <ClipInspector project={project} clip={clip} dispatch={dispatch} playhead={playhead} />;
    return <p className="muted placeholder">Select a clip or an effect on the timeline to edit it.</p>;
  }
  if (effect.kind !== "anim2d") return <Inspector3D project={project} effect={effect} playhead={playhead} dispatch={dispatch} preview={preview?.effectId === effect.id ? preview.params : null} onPreview={onPreview} onOpenTab={onOpenTab} />;
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
      {Array.isArray(effect.params.sounds) && (effect.params.sounds as unknown[]).length > 0 && (
        <fieldset className="param-group">
          <legend>Sound</legend>
          <label className="param-field" data-param="soundGain">
            <span>Volume (0 = off)</span>
            <CommitInput type="number" data-testid="effect-sound-gain" value={soundGain(effect)} step={0.05} min={0} max={1}
              onCommit={(x) => update({ ...effect.params, soundGain: Math.min(1, Math.max(0, Number(x) || 0)) })} />
          </label>
        </fieldset>
      )}
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
            <LayerFillField textures={(project.textures ?? []).filter((t) => t.kind === "texture")} fill={(layer as { fill?: LayerFill }).fill}
              onChange={(fill) => update({ ...effect.params, layers: layers.map((l, j) => (j !== i ? l : fill ? { ...l, fill } : withoutFill(l))) })}
              onNew={onOpenTab ? () => onOpenTab("textures") : undefined} />
          </fieldset>
        );
      })}
    </div>
  );
}

/** 拿掉圖層的 fill */
function withoutFill<T extends object>(l: T): T {
  const { fill: _drop, ...rest } = l as T & { fill?: unknown };
  return rest as T;
}

/**
 * 2D 圖層的圖片填色（2026-11-02）：選材質庫的一張材質，圖層的形狀（文字、圖形）改用材質圖平鋪上色（例如金屬字、木紋字）。
 * 任何 2D 插件都能用，不用插件配合。
 */
function LayerFillField({ textures, fill, onChange, onNew }: {
  textures: TextureAsset[];
  fill: LayerFill | undefined;
  onChange: (fill: LayerFill | null) => void;
  /** 切到 Textures 頁籤產生新的材質 */
  onNew?: () => void;
}) {
  /** 選一張材質（保留原本的平鋪與強度） */
  const pick = (id: string) => {
    const t = textures.find((x) => x.id === id);
    onChange(t ? { textureId: t.id, color: t.colorMediaId, repeat: fill?.repeat ?? 2, mix: fill?.mix ?? 1 } : null);
  };
  return (
    <div className="layer-fill" data-testid="layer-fill">
      <label className="param-field"><span>Image fill</span>
        <select data-testid="layer-fill-texture" value={fill?.textureId ?? ""} onChange={(e) => (e.target.value === "__new" ? onNew?.() : pick(e.target.value))}>
          <option value="">None</option>
          {textures.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          {onNew && <option value="__new">New texture…</option>}
        </select>
      </label>
      {fill && (
        <>
          <label className="param-field"><span>Tiles</span>
            <CommitInput type="number" data-testid="layer-fill-repeat" value={fill.repeat ?? 2} step={0.5} min={0.25} max={20} onCommit={(x) => onChange({ ...fill, repeat: Math.min(20, Math.max(0.25, Number(x) || 2)) })} />
          </label>
          <label className="param-field"><span>Strength</span>
            <CommitInput type="number" data-testid="layer-fill-mix" value={fill.mix ?? 1} step={0.1} min={0} max={1} onCommit={(x) => onChange({ ...fill, mix: Math.min(1, Math.max(0, Number(x) || 0)) })} />
          </label>
        </>
      )}
    </div>
  );
}

/** 「用說的」同意說明的鍵 */
const PLANE3D_CONSENT = "wordblade.consent.plane3d";

/**
 * 「用說的」（spec §5.8，只有漂浮的板子）：一句話 → AI 提議板子的運鏡 → 預覽（不寫進專案）→ Apply 寫入（一筆可復原的編輯）或 Discard。
 */
function DescribeMove({ effect, current, preview, onPreview, dispatch }: { effect: Effect; current: BoardParams; preview: Record<string, unknown> | null; onPreview: (p: { effectId: string; params: Record<string, unknown> } | null) => void; dispatch: Dispatch<Action> }) {
  const [text, setText] = useState("");
  const [attach, setAttach] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const settings = loadSettings();

  /** 送出：第一次先問同意 */
  const propose = async (agreed = false) => {
    let ok = agreed;
    try { ok ||= localStorage.getItem(PLANE3D_CONSENT) === "yes"; } catch { /* 讀不到就問 */ }
    if (!ok) { setConsent(true); return; }
    setBusy(true);
    setError(null);
    try {
      const outcome = await runPlane3d(new GatewayClient(settings), {
        description: text.trim(), screenshot: attach ? captureFrame() : null, current, length: effect.end - effect.start, width: 1920, height: 1080,
      });
      if (outcome.ok) onPreview({ effectId: effect.id, params: outcome.params });
      else setError(outcome.message);
    } catch (e) {
      setError(e instanceof GatewayError ? e.message : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <fieldset className="param-group" data-testid="describe-move">
      <legend>Describe the move (AI)</legend>
      {preview ? (
        <div className="vibe-actions">
          <span>Previewing the AI's move.</span>
          <span className="spacer" />
          <button data-testid="move-apply" onClick={() => { dispatch({ type: "commit", edits: [{ kind: "setEffectParams", effectId: effect.id, params: { ...effect.params, params: preview } }] }); onPreview(null); }}>Apply</button>
          <button data-testid="move-discard" onClick={() => onPreview(null)}>Discard</button>
        </div>
      ) : (
        <>
          <textarea className="vibe-input" rows={2} maxLength={300} value={text} disabled={busy} data-testid="move-description" placeholder="e.g. Swing in from the right, then float gently" onChange={(e) => setText(e.target.value)} />
          <div className="vibe-actions">
            <label><input type="checkbox" checked={attach} onChange={(e) => setAttach(e.target.checked)} /> Attach current frame</label>
            <span className="spacer" />
            <button data-testid="move-propose" disabled={busy || !text.trim() || !settings.token} onClick={() => void propose()}>{busy ? "Thinking" : "Propose"}</button>
          </div>
          {!settings.token && <p className="muted">Set the invite token in Effects → 2D → AI settings first.</p>}
        </>
      )}
      {consent && (
        <div className="consent" data-testid="move-consent">
          <p>Your description{attach ? " and the current frame" : ""} will be sent to the WordBlade AI service and Meta Muse Spark (a Contributor model, which may use the content for training).</p>
          <button onClick={() => { try { localStorage.setItem(PLANE3D_CONSENT, "yes"); } catch { /* 只在這次有效 */ } setConsent(false); void propose(true); }}>Agree and continue</button> <button onClick={() => setConsent(false)}>Cancel</button>
        </div>
      )}
      {error && <p className="error" data-testid="move-error">{error}</p>}
    </fieldset>
  );
}

/** 3D 特效的設定：依 3D 元件的參數定義產生表單；關鍵幀這類複雜參數先唯讀顯示（用「用說的」或範本改） */
function Inspector3D({ project, effect, playhead, dispatch, preview, onPreview, onOpenTab }: { onOpenTab?: (tab: string) => void; project: Project; effect: Effect; playhead: number; dispatch: Dispatch<Action>; preview: Record<string, unknown> | null; onPreview: (p: { effectId: string; params: Record<string, unknown> } | null) => void }) {
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
            : <ParamField key={key} name={key} def={def} label={def.label ?? key} labels={def.labels} value={values[key]} onChange={(v) => set(key, v)} textures={project.textures} onNewTexture={() => onOpenTab?.("textures")} />)}
      </fieldset>
      {(component as { id?: string } | undefined)?.id === "desk-screen" && <CameraKeysEditor effect={effect} playhead={playhead} dispatch={dispatch} />}
      {(component as { id?: string } | undefined)?.id === "floating-board" && <DescribeMove effect={effect} current={values} preview={preview} onPreview={onPreview} dispatch={dispatch} />}
    </div>
  );
}

/** 沒有關鍵幀時新增的第一個鏡頭（和預設運鏡 reveal 的中段差不多：斜上方看螢幕） */
const DEFAULT_CAMERA_KEY: Omit<CameraKey, "t"> = { position: [0, 4.4, 9.5], target: [0, 1, 0], fov: 40 };

/**
 * 鏡頭關鍵幀編輯（spec §5.8，3D 場景用）：列出每個關鍵幀的時間（相對區段開頭）、鏡頭位置、看向的點、視角，可以改、新增、刪除。
 * 有關鍵幀時中段照關鍵幀平滑內插，頭尾仍接回滿版；全部刪掉就回到「Camera」參數的預設運鏡。每次改動是一筆可復原的編輯。
 */
function CameraKeysEditor({ effect, playhead, dispatch }: { effect: Effect; playhead: number; dispatch: Dispatch<Action> }) {
  const keys = effect.cameraKeys ?? [];
  const length = effect.end - effect.start;
  /** 寫回整組關鍵幀 */
  const commit = (next: CameraKey[]) => dispatch({ type: "commit", edits: [{ kind: "setCameraKeys", effectId: effect.id, keys: next }] });
  /** 改第 i 個關鍵幀的一個欄位 */
  const patch = (i: number, change: Partial<CameraKey>) => commit(keys.map((k, j) => (j === i ? { ...k, ...change } : k)));
  /** 在播放頭新增（播放頭不在區段內就放在最後一個之後 1 秒）；姿勢沿用最接近的那個關鍵幀 */
  const add = () => {
    const rel = playhead - effect.start;
    const last = keys.length ? keys[keys.length - 1].t : -1;
    const t = Math.round((rel >= 0 && rel <= length && !keys.some((k) => Math.abs(k.t - rel) < 0.01) ? rel : Math.min(length, last + 1)) * 100) / 100;
    const near = keys.reduce<CameraKey | null>((best, k) => (!best || Math.abs(k.t - t) < Math.abs(best.t - t) ? k : best), null);
    commit([...keys, { ...(near ?? DEFAULT_CAMERA_KEY), t, position: [...(near ?? DEFAULT_CAMERA_KEY).position], target: [...(near ?? DEFAULT_CAMERA_KEY).target] } as CameraKey]);
  };
  /** 三個數字的輸入列 */
  const vec = (i: number, field: "position" | "target", v: [number, number, number]) =>
    v.map((n, axis) => (
      <input key={axis} type="number" step={0.1} value={n} aria-label={`${field} ${"xyz"[axis]}`} data-key-field={`${field}-${axis}`}
        onChange={(e) => { const next = [...v] as [number, number, number]; next[axis] = Number(e.target.value); patch(i, { [field]: next }); }} />
    ));
  return (
    <fieldset className="param-group camera-keys" data-testid="camera-keys">
      <legend>Camera keyframes</legend>
      {keys.length === 0 && <p className="muted">No keyframes: the camera follows the "Camera" preset. Add one to place the camera yourself.</p>}
      {keys.map((k, i) => (
        <div key={i} className="camera-key" data-key-index={i}>
          <label className="param-field"><span>Time (sec)</span>
            {/* 時間改了會重新排序，輸入中途不寫回（否則列會換位、焦點跑到別的關鍵幀）；離開欄位或按 Enter 才寫回 */}
            <KeyTimeInput key={`${i}-${k.t}`} value={k.t} max={length} onCommit={(t) => patch(i, { t })} />
          </label>
          <label className="param-field"><span>Position</span><span className="vec3">{vec(i, "position", k.position)}</span></label>
          <label className="param-field"><span>Look at</span><span className="vec3">{vec(i, "target", k.target)}</span></label>
          <label className="param-field"><span>Field of view (°)</span>
            <input type="number" min={10} max={100} step={1} value={k.fov} data-key-field="fov" onChange={(e) => patch(i, { fov: Math.min(100, Math.max(10, Number(e.target.value))) })} />
          </label>
          <button type="button" data-testid="camera-key-delete" onClick={() => commit(keys.filter((_, j) => j !== i))}>Delete keyframe</button>
        </div>
      ))}
      <button type="button" data-testid="camera-key-add" onClick={add}>Add keyframe at playhead</button>
    </fieldset>
  );
}

/** 關鍵幀時間欄位：打字時只改本地草稿，blur 或 Enter 才寫回（夾在 0～區段長度） */
function KeyTimeInput({ value, max, onCommit }: { value: number; max: number; onCommit: (t: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  /** 寫回：數字有效且有變才送出，否則還原 */
  const commit = () => {
    const t = Math.round(Math.min(max, Math.max(0, Number(draft))) * 100) / 100;
    if (draft.trim() === "" || Number.isNaN(t)) setDraft(String(value));
    else if (t !== value) onCommit(t);
    else setDraft(String(value));
  };
  return (
    <input type="number" min={0} max={max} step={0.1} value={draft} data-key-field="t"
      onChange={(e) => setDraft(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }} />
  );
}

/** 轉場種類的顯示名稱（§5.9） */
const TRANSITIONS: { kind: TransitionKind; label: string }[] = [
  { kind: "dissolve", label: "Dissolve" },
  { kind: "dipBlack", label: "Dip to black" },
  { kind: "dipWhite", label: "Dip to white" },
  { kind: "pushLeft", label: "Push left" },
  { kind: "pushRight", label: "Push right" },
];

/** 片段起點的轉場（和前一段之間）：種類下拉＋長度；不改總長度 */
function TransitionField({ project, clip, dispatch }: { project: Project; clip: Clip; dispatch: Dispatch<Action> }) {
  const current = project.transitions?.find((t) => t.clipId === clip.id);
  /** 送出一次變更 */
  const set = (kind: TransitionKind | null, duration = current?.duration ?? TRANSITION_DEFAULT) =>
    dispatch({ type: "commit", edits: [{ kind: "setTransition", clipId: clip.id, transition: kind, duration }] });
  return (
    <fieldset className="param-group">
      <legend>Transition in</legend>
      <label className="param-field"><span>Type</span>
        <select data-testid="transition-kind" value={current?.kind ?? ""} onChange={(e) => set((e.target.value || null) as TransitionKind | null)}>
          <option value="">None</option>
          {TRANSITIONS.map((t) => <option key={t.kind} value={t.kind}>{t.label}</option>)}
        </select>
      </label>
      {current && (
        <label className="param-field"><span>Length (s)</span>
          <input type="number" data-testid="transition-duration" min={TRANSITION_MIN} max={TRANSITION_MAX} step={0.1} value={current.duration}
            onChange={(e) => { const v = Number(e.target.value); if (v > 0) set(current.kind, v); }} />
        </label>
      )}
      <p className="muted">Plays across the cut with the previous clip. The total length doesn't change.</p>
    </fieldset>
  );
}

/** 變速的常用倍數 */
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];

/**
 * 片段屬性（spec §5.20 片段變速，P1-6）：0.25～4 倍，常用倍數按鈕＋自訂。同位置的連動片段（A1 對白）一起變，
 * V1 片段變長變短時後面的一起挪（setClipSpeed）。每次一筆可復原的編輯。
 */
function ClipInspector({ project, clip, dispatch, playhead }: { project: Project; clip: Clip; dispatch: Dispatch<Action>; playhead?: number }) {
  const media = project.media.find((m) => m.id === clip.mediaId);
  const track = project.tracks.find((t) => t.id === clip.trackId);
  /** V1 片段才有轉場與定格；轉場要有前一段 */
  const isV1 = track?.kind === "video" && track.index === Math.min(...project.tracks.filter((t) => t.kind === "video").map((t) => t.index));
  const hasPrev = isV1 && project.clips.some((c) => c.trackId === clip.trackId && c.id !== clip.id && Math.abs(clipEnd(c) - clip.start) < 1e-6);
  const label = track ? `${track.kind === "video" ? "V" : "A"}${track.index + 1}` : "";
  /** 設倍數 */
  const set = (speed: number) => dispatch({ type: "commit", edits: [{ kind: "setSpeed", clipId: clip.id, speed }] });
  return (
    <div className="inspector" data-testid="clip-inspector">
      <h3 className="section-title">{media?.name ?? clip.mediaId}</h3>
      <p className="muted">{label} · {clip.start.toFixed(2)}s – {clipEnd(clip).toFixed(2)}s{clip.freeze ? " · freeze frame" : ""}</p>
      <fieldset className="param-group" disabled={!!clip.freeze}>
        <legend>Speed</legend>
        <div className="speed-presets">
          {SPEEDS.map((s) => (
            <button key={s} type="button" data-speed={s} className={Math.abs(clip.speed - s) < 1e-6 ? "active" : ""} onClick={() => set(s)}>{s}×</button>
          ))}
        </div>
        <label className="param-field"><span>Custom</span>
          <input type="number" data-testid="speed-input" min={MIN_SPEED} max={MAX_SPEED} step={0.05} value={clip.speed}
            onChange={(e) => { const v = Number(e.target.value); if (v > 0) set(v); }} />
        </label>
        <p className="muted">The linked audio changes with it and keeps its pitch. Later clips move to stay in sync.</p>
      </fieldset>
      {isV1 && hasPrev && <TransitionField project={project} clip={clip} dispatch={dispatch} />}
      {isV1 && !clip.freeze && (
        <fieldset className="param-group">
          <legend>Freeze frame</legend>
          <button type="button" data-testid="freeze-insert" disabled={playhead === undefined || playhead < clip.start || playhead >= clipEnd(clip)}
            onClick={() => dispatch({ type: "commit", edits: [{ kind: "insertFreeze", t: playhead! }] })}>Freeze 2 s at playhead</button>
          <p className="muted">Shortcut: Shift+F. Later clips move back; the audio is silent while frozen.</p>
        </fieldset>
      )}
    </div>
  );
}
