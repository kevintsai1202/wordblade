// 特效 → Re-voice 子頁籤（spec §5.6，P2）：選一段時間軸範圍 → 改文字 → AI 用講者自己的聲音念出來，放在獨立的 Voice 音軌；
// 範圍內原本的對白在「AI」狀態下靜音，可隨時切回原音。聲音樣本（約 60～90 秒）取自主對白素材的逐字稿講話區段，
// 文字與樣本會送到 WordBlade AI 服務與 Fish Audio 克隆聲音（第一次用要同意）。
import { useEffect, useState, type Dispatch } from "react";
import { GatewayClient, GatewayError, loadSettings } from "../ai/gateway";
import { buildSeed, dialogueMedia, fitToRange, rangeText } from "../ai/revoice";
import type { Edit } from "../core/history";
import type { Media, Project } from "../core/model";
import type { Engine, ImportSource } from "../engine/Engine";
import { formatTimecode, type Action } from "./state";

/** 同意說明的鍵（同意過就不再問） */
const CONSENT_KEY = "wordblade.consent.voice";

/** 讀同意狀態 */
function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "yes";
  } catch {
    return false;
  }
}

/** 檔名用的短字：只留英數，最多 24 字 */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "ai";
}

/** 錯誤 → 給使用者看的文字 */
function message(e: unknown): string {
  return e instanceof GatewayError ? e.message : e instanceof Error ? e.message : `Something went wrong: ${String(e)}`;
}

/** 秒數顯示（一位小數） */
const sec = (t: number) => `${t.toFixed(1)} s`;

/** Re-voice 子頁籤 */
export function RevoiceTab({ engine, project, range, importSources, dispatch }: {
  engine: Engine;
  project: Project;
  /** 時間軸選的範圍（時間軸秒）：要重配音的那一段 */
  range?: { start: number; end: number } | null;
  /** 一般的匯入流程（useMediaLibrary）；回傳匯入成功的素材 */
  importSources: (sources: ImportSource[]) => Promise<Media[]>;
  dispatch: Dispatch<Action>;
}) {
  /** 要念的文字（選範圍時預設填入範圍內的逐字稿，可編輯） */
  const [text, setText] = useState("");
  /** 正在做的事（顯示在按鈕上；null＝閒著） */
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 等使用者同意後要接著做的事 */
  const [pending, setPending] = useState<(() => void) | null>(null);
  // 範圍換了就重新填入範圍內的逐字稿（只看範圍；專案其他地方變動不蓋掉使用者正在改的文字）
  useEffect(() => {
    setText(range ? rangeText(project, range) : "");
    setError(null);
  }, [range?.start, range?.end]); // eslint-disable-line react-hooks/exhaustive-deps

  const token = loadSettings().token;

  /** 產生：樣本 → 念（必要時再念一次加快語速）→ 進素材庫 → 放上 Voice 軌（一次提交，一次 Ctrl+Z 復原） */
  const generate = async (target: { start: number; end: number }, said: string) => {
    setError(null);
    try {
      const media = dialogueMedia(project);
      if (!media) throw new Error("There's no dialogue to learn the voice from. Add a video with speech to the timeline first.");
      setBusy("Preparing voice sample…");
      const seed = await buildSeed(media, project.words, (m, s, e) => engine.extractAsrAudio(m, s, e));
      const client = new GatewayClient(loadSettings());
      setBusy("Generating voice…");
      const fitted = await fitToRange(
        (speed) => client.speak({ text: said, seed: seed.wav, seedText: seed.text, speed }),
        target.end - target.start,
      );
      setBusy("Adding to timeline…");
      const source = await engine.importGenerated(`voice-${slug(said)}-${crypto.randomUUID().slice(0, 6)}.wav`, fitted.audio);
      const [voice] = await importSources([source]);
      if (!voice) throw new Error("Couldn't add the voice to the media library.");
      const edit: Edit = {
        kind: "addVoiceover",
        voiceover: { id: `vo-${crypto.randomUUID().slice(0, 8)}`, start: target.start, end: target.end, text: said, mediaId: voice.id },
        speed: fitted.clipSpeed,
      };
      dispatch({ type: "commit", edits: [edit] });
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  /** 按 Generate：沒同意過先問 */
  const onGenerate = () => {
    if (!range || !text.trim()) return;
    const target = { ...range };
    const said = text.trim();
    if (hasConsent()) void generate(target, said);
    else setPending(() => () => void generate(target, said));
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

  const voiceovers = project.voiceovers ?? [];
  return (
    <div className="vibe-tab" data-testid="revoice-tab">
      <h3 className="section-title">Re-voice</h3>
      <p className="muted" data-testid="revoice-range">
        {range ? `Selected range: ${formatTimecode(range.start).slice(3)} – ${formatTimecode(range.end).slice(3)} (${sec(range.end - range.start)})` : "Shift-drag on the timeline to select the part to re-voice."}
      </p>
      <textarea
        className="vibe-input" data-testid="revoice-text" rows={4} maxLength={1000} value={text} disabled={busy !== null || !range}
        placeholder="What the voice should say" onChange={(e) => setText(e.target.value)}
      />
      <div className="vibe-actions">
        <span className="muted">The AI copies the speaker's voice and fits the range.</span>
        <span className="spacer" />
        <button data-testid="revoice-generate" disabled={busy !== null || !range || !text.trim() || !token} title={!token ? "Set the invite token in Effects → 2D → AI settings first" : undefined} onClick={onGenerate}>
          {busy ?? "Generate"}
        </button>
      </div>
      {error && <p className="error" data-testid="revoice-error">{error}</p>}
      {pending && (
        <div className="consent" data-testid="revoice-consent">
          <p>The selected text and a 60–90 second sample of the speaker's voice will be sent to the WordBlade AI service and Fish Audio to clone the voice.</p>
          <button onClick={acceptConsent}>Agree and continue</button> <button onClick={() => setPending(null)}>Cancel</button>
        </div>
      )}
      {voiceovers.length > 0 && (
        <>
          <h3 className="section-title">In this project</h3>
          <ul className="transcribe-list" data-testid="revoice-list">
            {voiceovers.map((v) => (
              <li key={v.id} data-testid="revoice-item" data-voiceover-id={v.id} data-active={v.active}>
                <span className="media-name" title={v.text}>{v.text}</span>
                <span className="muted">{formatTimecode(v.start).slice(3)} – {formatTimecode(v.end).slice(3)}</span>
                <button type="button" data-testid="revoice-toggle" title="Switch between the original audio and the AI voice"
                  onClick={() => dispatch({ type: "commit", edits: [{ kind: "setVoiceoverActive", id: v.id, active: !v.active }] })}>
                  {v.active ? "Playing: AI" : "Playing: Original"}
                </button>
                <button type="button" data-testid="revoice-delete" onClick={() => dispatch({ type: "commit", edits: [{ kind: "deleteVoiceover", id: v.id }] })}>Delete</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
