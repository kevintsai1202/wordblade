// 特效 → 材質子頁籤（spec §5.12、D36，P1-14）：一句描述 → 閘道 /v1/ai/image（Muse Image）→ 本機後處理（去暗角、無縫化、法線圖）
// → 存進專案的材質庫（Project.textures）。材質的兩張圖（顏色、法線）是素材庫裡 role="texture" 的 PNG，素材庫頁籤不列；
// 3D 背景只縮放、不做無縫化與法線，一張圖。套用的地方在 Inspector：3D 場景的 texture 參數下拉選這裡的項目。
// AI 設定（閘道網址、邀請權杖）和 Vibe特效、音效共用；第一次產生時顯示同意說明（送什麼、送到哪）。
import { useEffect, useState, type Dispatch } from "react";
import { GatewayClient, GatewayError, loadSettings, saveSettings, type GatewaySettings } from "../ai/gateway";
import { rewriteLayerFills, rewriteTextureRefs } from "../anim/textureRefs";
import type { Edit } from "../core/history";
import type { Media, Project, TextureAsset } from "../core/model";
import type { Engine, ImportSource } from "../engine/Engine";
import { createTextureAsset } from "../texture/create";
import type { Action } from "./state";

/** 同意說明的鍵（同意過就不再問） */
const CONSENT_KEY = "wordblade.consent.texture";

/** 讀同意狀態 */
function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "yes";
  } catch {
    return false;
  }
}

/** 錯誤 → 給使用者看的一句話 */
function message(e: unknown): string {
  return e instanceof GatewayError ? e.message : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
}

/** 法線強度滑桿：拖的時候只改本地的值，放開（或鍵盤調整完、離開）才寫進專案，免得拖一下就留幾十筆歷史 */
function StrengthSlider({ value, onCommit }: { value: number; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  /** 值有變才送出 */
  const commit = () => { if (draft !== value) onCommit(draft); };
  return (
    <input type="range" data-testid="texture-strength" min={0} max={2} step={0.1} value={draft}
      onChange={(e) => setDraft(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} />
  );
}

/** 材質子頁籤 */
export function TextureTab({ project, engine, importSources, dispatch }: {
  project: Project;
  engine: Engine;
  /** 一般的匯入流程（useMediaLibrary）；回傳匯入成功的素材 */
  importSources: (sources: ImportSource[]) => Promise<Media[]>;
  dispatch: Dispatch<Action>;
}) {
  const [settings, setSettings] = useState<GatewaySettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  /** 等使用者同意後要接著做的事 */
  const [pending, setPending] = useState<(() => void) | null>(null);
  /** 描述與種類（材質／3D 背景） */
  const [text, setText] = useState("");
  const [kind, setKind] = useState<TextureAsset["kind"]>("texture");
  /** 正在做的事（顯示在按鈕上；null＝閒著） */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const textures = project.textures ?? [];
  const noToken = !settings.token;

  /** 需要 AI 的動作：沒同意過先問 */
  const withConsent = (action: () => void) => {
    if (hasConsent()) action();
    else setPending(() => action);
  };

  /** 同意後接著做 */
  const acceptConsent = () => {
    try {
      localStorage.setItem(CONSENT_KEY, "yes");
    } catch {
      /* 存不了就只在這次有效 */
    }
    const action = pending;
    setPending(null);
    action?.();
  };

  /** 一張 PNG 存進素材庫並標成材質用的圖（role="texture"，素材庫頁籤不列），回傳素材 id */
  const saveImage = async (name: string, bytes: Uint8Array): Promise<string> => {
    const [media] = await importSources([{ ...(await engine.importGenerated(name, bytes)), role: "texture" }]);
    if (!media) throw new Error("the image couldn't be added to the project");
    return media.id;
  };

  /**
   * 產生一張材質或背景：呼叫閘道 → 後處理 → 存進素材庫 → 寫進材質庫（一筆可復原的編輯）。
   * again 有值＝再產生：同一個項目（id、名字、強度、平鋪不變）換新圖，特效參數裡指向它的引用跟著換，舊圖從專案拿掉。
   */
  const make = async (forKind: TextureAsset["kind"], prompt: string, again?: TextureAsset) => {
    setError(null);
    try {
      const texture = await createTextureAsset(new GatewayClient(settings), forKind, prompt, saveImage,
        (stage) => setBusy(stage === "generating" ? "Generating…" : "Processing…"), again);
      const { colorMediaId, normalMediaId } = texture;
      const edits: Edit[] = [{ kind: "addTexture", texture }];
      if (again) {
        // 特效裡的引用換成新圖；舊圖不再有人用，從專案拿掉
        edits.push(...refEdits(again.id, (ref) => ({ ...ref, color: colorMediaId, ...(normalMediaId ? { normal: normalMediaId } : { normal: undefined }) })));
        edits.push(...mediaIdsOf(again).map((mediaId): Edit => ({ kind: "removeMedia", mediaId })));
      }
      dispatch({ type: "commit", edits });
      if (!again) setText("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  /** 材質用到的素材 id（顏色、法線） */
  const mediaIdsOf = (t: TextureAsset) => [t.colorMediaId, ...(t.normalMediaId ? [t.normalMediaId] : [])];

  /** 專案裡每個特效的參數若有指向這個材質的引用，改寫成新的設定（change 回傳 null 就拿掉）；沒有引用的特效不產生編輯 */
  const refEdits = (textureId: string, change: Parameters<typeof rewriteTextureRefs>[2]): Edit[] =>
    project.effects.flatMap((e): Edit[] => {
      // 3D 參數裡的引用與 2D 圖層的圖片填色（2026-11-02）一起改
      const next = rewriteLayerFills(rewriteTextureRefs(e.params, textureId, change), textureId, change);
      return next === e.params ? [] : [{ kind: "setEffectParams", effectId: e.id, params: next }];
    });

  /** 調法線強度：材質庫的項目與特效裡的引用一起改（同一次復原） */
  const setStrength = (t: TextureAsset, normalStrength: number) =>
    dispatch({ type: "commit", edits: [{ kind: "setTexture", textureId: t.id, patch: { normalStrength } }, ...refEdits(t.id, (ref) => ({ ...ref, normalStrength }))] });

  /** 刪除：材質庫的項目、特效裡的引用（回到預設）、兩張圖一起拿掉（同一次復原） */
  const remove = (t: TextureAsset) =>
    dispatch({ type: "commit", edits: [{ kind: "deleteTexture", textureId: t.id }, ...refEdits(t.id, () => null), ...mediaIdsOf(t).map((mediaId): Edit => ({ kind: "removeMedia", mediaId }))] });

  /** 預覽圖的網址（素材找不到就沒有） */
  const urlOf = (mediaId: string) => {
    const media = project.media.find((m) => m.id === mediaId);
    return media ? engine.mediaUrl(media) : null;
  };

  return (
    <div className="vibe-tab" data-testid="texture-tab">
      <h3 className="section-title">Textures and 3D backgrounds</h3>
      <textarea
        className="vibe-input" data-testid="texture-description" rows={2} maxLength={300} value={text} disabled={busy !== null}
        placeholder={kind === "texture" ? 'Describe a surface, e.g. "worn oak planks" or "dark green chalkboard with chalk dust"' : 'Describe a scene, e.g. "a cozy classroom with a chalkboard"'}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="vibe-actions">
        <label>Make a{" "}
          <select data-testid="texture-kind" value={kind} disabled={busy !== null} onChange={(e) => setKind(e.target.value as TextureAsset["kind"])}>
            <option value="texture">Texture</option>
            <option value="background">3D background</option>
          </select>
        </label>
        <span className="spacer" />
        <button data-testid="texture-generate" disabled={busy !== null || !text.trim() || noToken} title={noToken ? "Set the invite token in AI settings first" : undefined}
          onClick={() => withConsent(() => void make(kind, text.trim()))}>
          {busy ?? "Generate"}
        </button>
      </div>
      {error && <p className="error" data-testid="texture-error">{error}</p>}

      {textures.length > 0 && <h3 className="section-title">In this project</h3>}
      <ul className="texture-list" data-testid="texture-list">
        {textures.map((t) => {
          const url = urlOf(t.colorMediaId);
          return (
            <li key={t.id} className="texture-item" data-testid="texture-item" data-kind={t.kind} data-texture-id={t.id}>
              {/* 材質：2×2 拼貼，看得出接縫；背景：整張縮在框裡 */}
              <div className={`texture-tile ${t.kind}`} data-testid="texture-preview" style={url ? { backgroundImage: `url(${url})`, backgroundSize: t.kind === "texture" ? "50%" : "cover" } : undefined} />
              <div className="texture-meta">
                <span className="texture-name" data-testid="texture-name" title={t.prompt}>{t.name}</span>
                <span className="muted">{t.kind === "texture" ? "Texture" : "3D background"}</span>
                {t.kind === "texture" && t.normalMediaId && (
                  <label className="param-field"><span>Bumps</span><StrengthSlider value={t.normalStrength} onCommit={(v) => setStrength(t, v)} /></label>
                )}
                <div className="vibe-actions">
                  <button data-testid="texture-regenerate" disabled={busy !== null || noToken} title="Generate another one from the same description (effects using it switch to the new image)"
                    onClick={() => withConsent(() => void make(t.kind, t.prompt, t))}>Regenerate</button>
                  <button data-testid="texture-delete" disabled={busy !== null} title="Remove from the project (effects using it go back to the default). Ctrl+Z to undo." onClick={() => remove(t)}>Delete</button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>

      {pending && (
        <div className="consent" data-testid="texture-consent">
          <p>Your description will be sent to the WordBlade AI service and Meta Muse Image to draw the picture. Muse Image runs as the Contributor version: Meta may use what you send to train its models.</p>
          <button onClick={acceptConsent}>Agree and continue</button> <button onClick={() => setPending(null)}>Cancel</button>
        </div>
      )}
      <button className="link" onClick={() => setShowSettings((s) => !s)}>{showSettings ? "Hide AI settings" : noToken ? "AI settings (needed for Generate)" : "AI settings"}</button>
      {showSettings && (
        <form className="ai-settings" onSubmit={(e) => { e.preventDefault(); saveSettings(settings); setShowSettings(false); }}>
          <label className="param-field"><span>Service URL</span><input type="url" value={settings.url} onChange={(e) => setSettings({ ...settings, url: e.target.value })} /></label>
          <label className="param-field"><span>Invite token</span><input type="password" value={settings.token} autoComplete="off" onChange={(e) => setSettings({ ...settings, token: e.target.value })} /></label>
          <button type="submit">Save</button>
        </form>
      )}
      <p className="muted">Pick a texture in Inspector for a 3D scene (Effects → 3D → "Screen in a scene"). The picture is made by AI, then made seamless on your computer.</p>
    </div>
  );
}
