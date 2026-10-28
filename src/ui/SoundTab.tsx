// 特效 → 音效子頁籤（spec §5.15、D27）：上半是 AI 音效（內建範本直接用，或一句描述請 AI 生成），下半是 AI 音樂（WebAudio 版，可循環）。
// 模型只回宣告式 JSON，這裡用 audio/synth/render 算成 WAV → 素材庫（Windows 版寫進 generated/，網頁版是 File）→ 放到 A3 音效軌或 A2 配樂軌。
// AI 設定（閘道網址、邀請權杖）和 Vibe特效共用；第一次用 AI 時顯示同意說明（送什麼、送到哪；Muse Spark Contributor 版的內容可能被用於訓練，D32）。
import { useEffect, useRef, useState, type Dispatch } from "react";
import { ensureAudioGraph } from "../audio/audioGraph";
import { SYNTH_RATE, renderMusic, renderSound, synthToWav } from "../audio/synth/render";
import { musicSeconds, type MusicSpec, type SoundSpec } from "../audio/synth/spec";
import { SOUND_TEMPLATES } from "../audio/synth/templates";
import { GatewayClient, GatewayError, loadSettings, saveSettings, type GatewaySettings } from "../ai/gateway";
import { runMusic, runSound } from "../ai/synth";
import type { Media, Project } from "../core/model";
import type { Engine, ImportSource } from "../engine/Engine";
import type { Action } from "./state";

/** 同意說明的鍵（同意過就不再問） */
const CONSENT_KEY = "wordblade.consent.audio";
/** 配樂可選的小節數 */
const BAR_CHOICES = [4, 8, 16];

/** 算好的一版音效或配樂 */
interface Rendered<S> {
  spec: S;
  /** 單聲道樣本（預覽用） */
  samples: Float32Array;
  /** 素材庫用的檔名 */
  name: string;
  /** 顯示用的名字（範本名或描述） */
  label: string;
  /** 配樂的原始描述（改版後仍是第一次的描述；Regenerate 用它） */
  prompt?: string;
  /** 已經進素材庫的話，素材 id（加到時間軸不再重複匯入） */
  mediaId?: string;
}

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

/** 新檔名：前綴＋短字＋亂數，避免同名 */
function fileName(prefix: "sfx" | "music", text: string): string {
  return `${prefix}-${slug(text)}-${crypto.randomUUID().slice(0, 6)}.wav`;
}

/** 錯誤 → 給使用者看的文字 */
function message(e: unknown): string {
  return e instanceof GatewayError ? e.message : `Something went wrong: ${e instanceof Error ? e.message : String(e)}`;
}

/** 音效子頁籤 */
export function SoundTab({ engine, project, playhead, range, importSources, dispatch }: {
  engine: Engine;
  project: Project;
  playhead: number;
  /** 時間軸選的範圍：有就放在範圍起點，沒有就放在播放頭 */
  range?: { start: number; end: number } | null;
  /** 一般的匯入流程（useMediaLibrary）；回傳匯入成功的素材 */
  importSources: (sources: ImportSource[]) => Promise<Media[]>;
  dispatch: Dispatch<Action>;
}) {
  const [settings, setSettings] = useState<GatewaySettings>(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  /** 等使用者同意後要接著做的事 */
  const [pending, setPending] = useState<(() => void) | null>(null);
  /** 正在做的事（顯示在按鈕上；null＝閒著） */
  const [busy, setBusy] = useState<{ part: "sound" | "music"; label: string } | null>(null);

  const [soundText, setSoundText] = useState("");
  const [soundLength, setSoundLength] = useState(1);
  const [sound, setSound] = useState<Rendered<SoundSpec> | null>(null);
  const [soundError, setSoundError] = useState<string | null>(null);

  const [musicText, setMusicText] = useState("");
  const [bars, setBars] = useState(8);
  const [music, setMusic] = useState<Rendered<MusicSpec> | null>(null);
  const [musicError, setMusicError] = useState<string | null>(null);
  /** 「改一下」的修改指示 */
  const [tweak, setTweak] = useState("");

  /** 正在預覽的聲音（再按一次或換一個就停） */
  const preview = useRef<AudioBufferSourceNode | null>(null);
  useEffect(() => () => preview.current?.stop(), []);

  /** 預覽：用共用的 AudioContext 播樣本（在按鈕的手勢裡呼叫） */
  const play = (samples: Float32Array) => {
    const graph = ensureAudioGraph();
    if (!graph) return;
    preview.current?.stop();
    const buffer = graph.ctx.createBuffer(1, samples.length, SYNTH_RATE);
    buffer.copyToChannel(samples as Float32Array<ArrayBuffer>, 0);
    const src = graph.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(graph.ctx.destination);
    src.start();
    preview.current = src;
  };

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

  /** 音效 spec → 樣本，成為目前的音效並播一次 */
  const showSound = async (spec: SoundSpec, label: string) => {
    setBusy({ part: "sound", label: "Rendering…" });
    try {
      const samples = await renderSound(spec);
      setSound({ spec, samples, label, name: fileName("sfx", label) });
      play(samples);
    } finally {
      setBusy(null);
    }
  };

  /** 內建範本：不用 AI，直接算 */
  const applyTemplate = async (id: string) => {
    const t = SOUND_TEMPLATES.find((x) => x.id === id)!;
    setSoundError(null);
    setSoundLength(t.spec.length);
    try {
      await showSound(t.spec, t.id);
    } catch (e) {
      setSoundError(message(e));
    }
  };

  /** 一句描述請 AI 生成音效 */
  const generateSound = async () => {
    setSoundError(null);
    setBusy({ part: "sound", label: "Generating…" });
    try {
      const outcome = await runSound(new GatewayClient(settings), { description: soundText.trim(), length: soundLength });
      if (outcome.ok) await showSound(outcome.spec, soundText.trim());
      else setSoundError(outcome.message);
    } catch (e) {
      setSoundError(message(e));
    } finally {
      setBusy(null);
    }
  };

  /** 請 AI 生成配樂；previous＋instruction 是「改一下」 */
  const generateMusic = async (description: string, previous: MusicSpec | null) => {
    setMusicError(null);
    setBusy({ part: "music", label: "Generating…" });
    try {
      const outcome = await runMusic(new GatewayClient(settings), { description, bars: previous?.bars ?? bars, previous });
      if (!outcome.ok) {
        setMusicError(outcome.message);
        return;
      }
      setBusy({ part: "music", label: "Rendering…" });
      const samples = await renderMusic(outcome.spec);
      // 改版沿用原本的描述（Regenerate 用它重來，不會把修改指示疊進去）
      const prompt = previous ? music?.prompt ?? description : description;
      const label = previous ? `${music?.label ?? "music"} (${description})` : description;
      setMusic({ spec: outcome.spec, samples, label, prompt, name: fileName("music", prompt) });
      if (previous) setTweak("");
    } catch (e) {
      setMusicError(message(e));
    } finally {
      setBusy(null);
    }
  };

  /** 放進素材庫（同一版只匯入一次），回傳素材 id */
  const saveToLibrary = async <S,>(item: Rendered<S>, update: (r: Rendered<S>) => void): Promise<string | null> => {
    if (item.mediaId) return item.mediaId;
    const source = await engine.importGenerated(item.name, synthToWav(item.samples));
    const [media] = await importSources([source]);
    if (!media) return null;
    update({ ...item, mediaId: media.id });
    return media.id;
  };

  /** 放到時間軸：音效 → 音效軌（A3）、配樂 → 配樂軌（A2）；有選範圍就放在範圍起點，否則放在播放頭。一次復原 */
  const addToTimeline = async <S,>(item: Rendered<S>, role: "sfx" | "music", update: (r: Rendered<S>) => void, setError: (m: string | null) => void) => {
    setError(null);
    const track = project.tracks.find((t) => t.kind === "audio" && t.role === role);
    if (!track) return setError(`There's no ${role === "sfx" ? "sound effects" : "music"} track.`);
    if (track.locked) return setError(`The ${role === "sfx" ? "sound effects" : "music"} track is locked.`);
    try {
      const mediaId = await saveToLibrary(item, update);
      if (!mediaId) return setError("Couldn't add it to the media library.");
      dispatch({ type: "commit", edits: [{ kind: "place", mediaId, trackId: track.id, t: range ? range.start : playhead }] });
    } catch (e) {
      setError(message(e));
    }
  };

  /** 只放進素材庫 */
  const save = async <S,>(item: Rendered<S>, update: (r: Rendered<S>) => void, setError: (m: string | null) => void) => {
    setError(null);
    try {
      if (!(await saveToLibrary(item, update))) setError("Couldn't add it to the media library.");
    } catch (e) {
      setError(message(e));
    }
  };

  const noToken = !settings.token;
  const where = range ? `at the start of the selected range (${range.start.toFixed(1)} s)` : "at the playhead";
  return (
    <div className="vibe-tab" data-testid="sound-tab">
      <h3 className="section-title">Sound effects</h3>
      <div className="vibe-examples">
        <span className="muted">Templates:</span>
        {SOUND_TEMPLATES.map((t) => (
          <button key={t.id} className="example-chip" data-testid="sound-template" data-template={t.id} disabled={busy !== null} title={t.description} onClick={() => void applyTemplate(t.id)}>{t.title}</button>
        ))}
      </div>
      <textarea
        className="vibe-input" data-testid="sound-description" rows={2} maxLength={300} value={soundText} disabled={busy !== null}
        placeholder='Or describe one, e.g. "a soft whoosh" or "keyboard typing"' onChange={(e) => setSoundText(e.target.value)}
      />
      <div className="vibe-actions">
        <label>Length <input type="number" data-testid="sound-length" min={0.1} max={10} step={0.1} value={soundLength} style={{ width: "4.5em" }}
          onChange={(e) => setSoundLength(Math.min(10, Math.max(0.1, Number(e.target.value) || 1)))} /> s</label>
        <span className="spacer" />
        <button data-testid="sound-generate" disabled={busy !== null || !soundText.trim() || noToken} title={noToken ? "Set the invite token in AI settings first" : undefined} onClick={() => withConsent(() => void generateSound())}>
          {busy?.part === "sound" ? busy.label : "Generate"}
        </button>
      </div>
      {sound && (
        <div className="vibe-actions" data-testid="sound-result">
          <span className="muted" title={sound.label}>{sound.label} · {(sound.samples.length / SYNTH_RATE).toFixed(2)} s</span>
          <span className="spacer" />
          <button data-testid="sound-play" onClick={() => play(sound.samples)}>▶ Play</button>
          <button data-testid="sound-save" disabled={!!sound.mediaId} onClick={() => void save(sound, setSound, setSoundError)}>{sound.mediaId ? "In media" : "Save to media"}</button>
          <button data-testid="sound-add" title={`Add to the sound effects track ${where}`} onClick={() => void addToTimeline(sound, "sfx", setSound, setSoundError)}>Add to timeline</button>
        </div>
      )}
      {soundError && <p className="error" data-testid="sound-error">{soundError}</p>}

      <h3 className="section-title">Music (loops seamlessly)</h3>
      <textarea
        className="vibe-input" data-testid="music-description" rows={2} maxLength={300} value={musicText} disabled={busy !== null}
        placeholder='e.g. "calm lo-fi, 80 BPM" or "upbeat tech background"' onChange={(e) => setMusicText(e.target.value)}
      />
      <div className="vibe-actions">
        <label>Bars <select data-testid="music-bars" value={bars} onChange={(e) => setBars(Number(e.target.value))}>
          {BAR_CHOICES.map((b) => <option key={b} value={b}>{b}</option>)}
        </select></label>
        <span className="spacer" />
        <button data-testid="music-generate" disabled={busy !== null || !musicText.trim() || noToken} title={noToken ? "Set the invite token in AI settings first" : undefined} onClick={() => withConsent(() => void generateMusic(musicText.trim(), null))}>
          {busy?.part === "music" ? busy.label : "Generate"}
        </button>
      </div>
      {music && (
        <>
          <div className="vibe-actions" data-testid="music-result">
            <span className="muted" title={music.label}>{music.spec.bars} bars · {music.spec.bpm} BPM · {musicSeconds(music.spec).toFixed(1)} s</span>
            <span className="spacer" />
            <button data-testid="music-play" onClick={() => play(music.samples)}>▶ Play</button>
            <button data-testid="music-save" disabled={!!music.mediaId} onClick={() => void save(music, setMusic, setMusicError)}>{music.mediaId ? "In media" : "Save to media"}</button>
            <button data-testid="music-add" title={`Add to the music track ${where}`} onClick={() => void addToTimeline(music, "music", setMusic, setMusicError)}>Add to timeline</button>
          </div>
          <div className="vibe-actions">
            <button data-testid="music-regenerate" disabled={busy !== null || noToken} title="Generate another take from the same description" onClick={() => withConsent(() => void generateMusic(music.prompt ?? music.label, null))}>Regenerate</button>
            <input type="text" data-testid="music-tweak" maxLength={300} value={tweak} placeholder="Change it, e.g. slower, no drums" style={{ flex: 1, minWidth: 0 }} onChange={(e) => setTweak(e.target.value)} />
            <button data-testid="music-modify" disabled={busy !== null || !tweak.trim() || noToken} onClick={() => withConsent(() => void generateMusic(tweak.trim(), music.spec))}>Modify</button>
          </div>
        </>
      )}
      {musicError && <p className="error" data-testid="music-error">{musicError}</p>}

      {pending && (
        <div className="consent" data-testid="audio-consent">
          <p>Your description (and, when you modify music, the previous version) will be sent to the WordBlade AI service and Meta Muse Spark to compose the sound. Muse Spark runs as the Contributor version: Meta may use what you send to train its models. Built-in templates work offline and send nothing.</p>
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
      <p className="muted">Add to timeline puts sound effects on the sound effects track and music on the music track, {where}.</p>
    </div>
  );
}
