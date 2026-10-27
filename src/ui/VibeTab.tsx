// Vibe FX 頁籤（spec §5.7）：上半是 Vibe特效（一句話請 AI 寫特效），下半是內建 2D 範本（點一下加在播放頭）。
// AI 設定（閘道網址、邀請權杖）存在這台電腦；第一次用 AI 時顯示同意說明（送什麼、送到哪，spec §3）。
import { useState, type Dispatch } from "react";
import { DEFAULT_EFFECT_SECONDS, TEMPLATES, templateEffect, type Template } from "../anim/library";
import type { PluginService } from "../anim/pluginService";
import { GatewayClient, GatewayError, loadSettings, saveSettings, type GatewaySettings } from "../ai/gateway";
import { runVibe, type VibeProgress } from "../ai/vibe";
import { TEMPLATES_3D, builtinPlugins3D, template3DEffect, type Template3D } from "../three/builtins";
import { captureFrame } from "./capture";
import { FPS, type Action } from "./state";

/** Vibe特效的範例描述（點一下填進輸入框；都是 10/27 實測一輪就做得出來的） */
export const VIBE_EXAMPLES = [
  "A burst of colorful confetti shooting up from the bottom of the box",
  "A countdown from 3 to 1 in big numbers in the middle of the box, each number popping in",
  "An arrow pointing at the box from the left, then a yellow 'Click here' label above it",
];

/** 同意說明的鍵（同意過就不再問） */
const CONSENT_KEY = "wordblade.consent.vibe";

/** 新特效的 id */
function newEffectId(): string {
  return `fx-${crypto.randomUUID().slice(0, 8)}`;
}

/** 讀同意狀態 */
function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "yes";
  } catch {
    return false;
  }
}

/** Vibe FX 頁籤 */
export function VibeTab({ plugins, playhead, dispatch }: { plugins: PluginService; playhead: number; dispatch: Dispatch<Action> }) {
  /** 沙盒、閘道或 AI 的錯誤訊息（固定文字，不顯示模型寫的文字） */
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<GatewaySettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(() => !loadSettings().token);
  const [description, setDescription] = useState("");
  const [attachFrame, setAttachFrame] = useState(true);
  const [progress, setProgress] = useState<VibeProgress | null>(null);
  const [consentAsked, setConsentAsked] = useState(false);

  /** 範本 → 特效（帶用到的內建插件），加在播放頭 */
  const addTemplate = async (template: Template) => {
    try {
      const builtins = await plugins.builtins();
      const used = template.layers.map((l) => builtins.get(l.component)!);
      const effect = templateEffect(template, (id) => builtins.get(id)!.hash, newEffectId(), playhead);
      dispatch({ type: "commit", edits: [{ kind: "addEffect", effect, plugins: used }] });
      dispatch({ type: "selectEffect", effectId: effect.id });
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  /** 3D 範本 → 特效（3D 場景蓋住 V1），加在播放頭 */
  const add3D = async (template: Template3D) => {
    try {
      const plugin = (await builtinPlugins3D()).get(template.componentId)!;
      const effect = template3DEffect(template, plugin, newEffectId(), playhead);
      dispatch({ type: "commit", edits: [{ kind: "addEffect", effect, plugins: [plugin] }] });
      dispatch({ type: "selectEffect", effectId: effect.id });
      setError(null);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    }
  };

  /** 一句話請 AI 寫特效：截圖（選）→ 閘道 → 沙盒試跑 → 加在播放頭 */
  const generate = async () => {
    if (!hasConsent()) {
      setConsentAsked(true);
      return;
    }
    setError(null);
    setProgress({ stage: "writing", round: 1 });
    try {
      const builtins = await plugins.builtins();
      const outcome = await runVibe(new GatewayClient(settings), plugins.host, builtins, {
        description: description.trim(), screenshot: attachFrame ? captureFrame() : null, start: playhead, duration: DEFAULT_EFFECT_SECONDS,
        box: { cx: 0.5, cy: 0.5, w: 0.3, h: 0.2 }, aspect: 16 / 9, fps: FPS, effectId: newEffectId(),
      }, setProgress);
      if (outcome.ok) {
        dispatch({ type: "commit", edits: [{ kind: "addEffect", effect: outcome.effect, plugins: outcome.plugins }] });
        dispatch({ type: "selectEffect", effectId: outcome.effect.id });
        setDescription("");
      } else {
        setError(outcome.message);
      }
    } catch (e) {
      setError(e instanceof GatewayError ? e.message : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setProgress(null);
    }
  };

  /** 同意後接著產生 */
  const acceptConsent = () => {
    try {
      localStorage.setItem(CONSENT_KEY, "yes");
    } catch {
      /* 存不了就只在這次有效 */
    }
    setConsentAsked(false);
    void generate();
  };

  const busy = progress !== null;
  return (
    <div className="vibe-tab">
      <h3 className="section-title">Vibe FX — describe an effect</h3>
      <textarea
        className="vibe-input" data-testid="vibe-description" rows={3} maxLength={500} value={description} disabled={busy}
        placeholder="e.g. A yellow arrow flies in from the left and points at the box, then sparkles"
        onChange={(e) => setDescription(e.target.value)}
      />
      <div className="vibe-examples">
        <span className="muted">Try:</span>
        {VIBE_EXAMPLES.map((ex) => (
          <button key={ex} className="example-chip" data-testid="vibe-example" disabled={busy} onClick={() => setDescription(ex)} title={ex}>{ex}</button>
        ))}
      </div>
      <div className="vibe-actions">
        <label><input type="checkbox" checked={attachFrame} onChange={(e) => setAttachFrame(e.target.checked)} /> Attach current frame</label>
        <span className="spacer" />
        <button data-testid="vibe-generate" disabled={busy || !description.trim() || !settings.token} onClick={() => void generate()}>
          {busy ? (progress.stage === "writing" ? `Writing… (round ${progress.round})` : "Checking…") : "Generate"}
        </button>
      </div>
      {consentAsked && (
        <div className="consent" data-testid="vibe-consent">
          <p>Your description{attachFrame ? " and the current frame" : ""} will be sent to the WordBlade AI service and Meta Muse (Muse Wonder) to write the effect.</p>
          <button onClick={acceptConsent}>Agree and continue</button> <button onClick={() => setConsentAsked(false)}>Cancel</button>
        </div>
      )}
      {error && <p className="error" data-testid="vibe-error">{error}</p>}
      <button className="link" onClick={() => setShowSettings((s) => !s)}>{showSettings ? "Hide AI settings" : "AI settings"}</button>
      {showSettings && (
        <form className="ai-settings" onSubmit={(e) => { e.preventDefault(); saveSettings(settings); setShowSettings(false); }}>
          <label className="param-field"><span>Service URL</span><input type="url" value={settings.url} onChange={(e) => setSettings({ ...settings, url: e.target.value })} /></label>
          <label className="param-field"><span>Invite token</span><input type="password" data-testid="vibe-token" value={settings.token} autoComplete="off" onChange={(e) => setSettings({ ...settings, token: e.target.value })} /></label>
          <button type="submit" data-testid="vibe-save-settings">Save</button>
        </form>
      )}

      <h3 className="section-title">3D scenes</h3>
      <ul className="template-grid">
        {TEMPLATES_3D.map((t) => (
          <li key={t.id}>
            <button className="template-card" data-template={t.id} onClick={() => void add3D(t)} title={t.name}>
              <span className="template-title">{t.title}</span>
              <span className="muted">{t.name}</span>
            </button>
          </li>
        ))}
      </ul>

      <h3 className="section-title">Templates</h3>
      <p className="muted">Click to add at the playhead. Drag the chip on the timeline to move or trim it.</p>
      <ul className="template-grid">
        {TEMPLATES.map((t) => (
          <li key={t.id}>
            <button className="template-card" data-template={t.id} onClick={() => void addTemplate(t)} title={t.name}>
              <span className="template-title">{t.title}</span>
              <span className="muted">{t.name}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
