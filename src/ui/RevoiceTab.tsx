// 特效 → Re-voice 子頁籤（spec §5.6，P2）：選一段時間軸範圍 → 改文字 → AI 用講者自己的聲音念出來，放在獨立的 Voice 音軌；
// 範圍內原本的對白在「AI」狀態下靜音，可隨時切回原音。聲音樣本（約 60～90 秒）取自主對白素材的逐字稿講話區段，
// 文字與樣本會送到 WordBlade AI 服務與 Fish Audio 克隆聲音（第一次用要同意）。
import { audioSourceFor } from "../core/stems";
import { useEffect, useRef, useState, type Dispatch } from "react";
import { startMic, type MicSession } from "../audio/micRecorder";
import { activeWordIndex, prompterWords, type PrompterWord } from "../ai/karaoke";
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

/** 開始錄之前倒數幾秒 */
const COUNTDOWN = 3;

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

  /**
   * 卡拉 OK 重配錄音（P1-9；2026-11-02）：倒數 → 錄音＋提詞器逐字高亮 → 到範圍長度自動停（也可手動停）
   * → 放到 Voice 軌（同 AI 重配音：範圍內原聲靜音、可切回原聲）。只用瀏覽器的麥克風；不送到任何服務。
   */
  const [karaoke, setKaraoke] = useState<{ phase: "countdown" | "recording"; left: number; elapsed: number; words: PrompterWord[]; target: { start: number; end: number }; said: string } | null>(null);
  /** 錄音中的麥克風與計時器（停止時要收） */
  const session = useRef<{ mic: MicSession | null; timer: ReturnType<typeof setInterval> | null; startedAt: number }>({ mic: null, timer: null, startedAt: 0 });
  useEffect(() => () => {
    if (session.current.timer) clearInterval(session.current.timer);
    session.current.mic?.cancel();
  }, []);

  /** 開始：先倒數，倒數完開麥克風開始錄 */
  const startKaraoke = () => {
    if (!range || !text.trim()) return;
    setError(null);
    const target = { ...range };
    const said = text.trim();
    const words = prompterWords(project, target, said);
    let left = COUNTDOWN;
    setKaraoke({ phase: "countdown", left, elapsed: 0, words, target, said });
    session.current.timer = setInterval(() => {
      left--;
      if (left > 0) {
        setKaraoke((k) => (k ? { ...k, left } : k));
        return;
      }
      clearInterval(session.current.timer!);
      session.current.timer = null;
      void beginRecording(target, said, words);
    }, 1000);
  };

  /** 倒數完：開麥克風、開始計時 */
  const beginRecording = async (target: { start: number; end: number }, said: string, words: PrompterWord[]) => {
    try {
      session.current.mic = await startMic();
    } catch (e) {
      setKaraoke(null);
      setError(`Couldn't use the microphone: ${message(e)}`);
      return;
    }
    session.current.startedAt = performance.now();
    setKaraoke({ phase: "recording", left: 0, elapsed: 0, words, target, said });
    const length = target.end - target.start;
    session.current.timer = setInterval(() => {
      const elapsed = (performance.now() - session.current.startedAt) / 1000;
      setKaraoke((k) => (k ? { ...k, elapsed } : k));
      if (elapsed >= length) void stopKaraoke(target, said);
    }, 50);
  };

  /** 停止（自動或手動）：錄好的放到 Voice 軌 */
  const stopKaraoke = async (target: { start: number; end: number }, said: string) => {
    if (session.current.timer) clearInterval(session.current.timer);
    session.current.timer = null;
    const mic = session.current.mic;
    session.current.mic = null;
    setKaraoke(null);
    if (!mic) return;
    setBusy("Adding your take…");
    try {
      const take = await mic.stop();
      const source = await engine.importGenerated(`take-${slug(said)}-${crypto.randomUUID().slice(0, 6)}.wav`, take.wav);
      const [voice] = await importSources([source]);
      if (!voice) throw new Error("Couldn't add the recording to the media library.");
      const edit: Edit = {
        kind: "addVoiceover",
        voiceover: { id: `vo-${crypto.randomUUID().slice(0, 8)}`, start: target.start, end: target.end, text: said, mediaId: voice.id, source: "recorded" },
      };
      dispatch({ type: "commit", edits: [edit] });
      if (take.peak >= 0.99) setError("The recording is clipping. Move back from the mic or lower the input level and try again.");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  /** 放棄這次錄音 */
  const cancelKaraoke = () => {
    if (session.current.timer) clearInterval(session.current.timer);
    session.current.timer = null;
    session.current.mic?.cancel();
    session.current.mic = null;
    setKaraoke(null);
  };

  /** 產生：樣本 → 念（必要時再念一次加快語速）→ 進素材庫 → 放上 Voice 軌（一次提交，一次 Ctrl+Z 復原） */
  const generate = async (target: { start: number; end: number }, said: string) => {
    setError(null);
    try {
      const media = dialogueMedia(project);
      if (!media) throw new Error("There's no dialogue to learn the voice from. Add a video with speech to the timeline first.");
      setBusy("Preparing voice sample…");
      const seed = await buildSeed(media, project.words, (m, s, e) => engine.extractAsrAudio(audioSourceFor(project, m), s, e));
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
        <button data-testid="revoice-record" disabled={busy !== null || karaoke !== null || !range || !text.trim()} title="Read the text yourself while it highlights word by word (karaoke)" onClick={startKaraoke}>● Record</button>
        <button data-testid="revoice-generate" disabled={busy !== null || karaoke !== null || !range || !text.trim() || !token} title={!token ? "Set the invite token in Effects → 2D → AI settings first" : undefined} onClick={onGenerate}>
          {busy ?? "Generate"}
        </button>
      </div>
      {karaoke && (
        <div className="karaoke" data-testid="karaoke" data-phase={karaoke.phase}>
          {karaoke.phase === "countdown"
            ? <p className="karaoke-countdown" data-testid="karaoke-countdown">{karaoke.left}</p>
            : <p className="muted" data-testid="karaoke-time">Recording · {sec(karaoke.elapsed)} / {sec(karaoke.target.end - karaoke.target.start)}</p>}
          <p className="karaoke-text" data-testid="karaoke-text">
            {karaoke.words.map((w, k) => {
              const at = karaoke.phase === "recording" ? activeWordIndex(karaoke.words, karaoke.elapsed) : -1;
              return <span key={k} className={k < at ? "said" : k === at ? "now" : ""} data-word={k}>{w.text} </span>;
            })}
          </p>
          <div className="vibe-actions">
            {karaoke.phase === "recording" && <button data-testid="karaoke-stop" onClick={() => void stopKaraoke(karaoke.target, karaoke.said)}>■ Stop</button>}
            <button data-testid="karaoke-cancel" onClick={cancelKaraoke}>Cancel</button>
          </div>
        </div>
      )}
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
                <button type="button" data-testid="revoice-toggle" title="Switch between the original audio and the new voice"
                  onClick={() => dispatch({ type: "commit", edits: [{ kind: "setVoiceoverActive", id: v.id, active: !v.active }] })}>
                  {v.active ? (v.source === "recorded" ? "Playing: Your take" : "Playing: AI") : "Playing: Original"}
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
