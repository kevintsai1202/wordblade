// 遮罩頁籤（Effects → Mask，spec §5.3 SAM 3.1）：選要遮的東西（常用目標或自己打，任何語言 → Muse Spark 轉英文名詞片語）→
// 範圍（時間軸選的範圍，沒有就用播放頭所在的 V1 片段整段）→ 同意說明（上傳 Meta、保留多久、格數與估價）→ 執行（可取消）→
// 物件清單：每個物件可開關、選效果（馬賽克／模糊／純色）、強度、外擴，跳到出現的地方、刪除。每次改動是一筆可復原的編輯。
import { useEffect, useRef, useState, type Dispatch } from "react";
import { GatewayError, loadSettings } from "../ai/gateway";
import { beginBusy } from "../core/busy";
import { maskSourceRange } from "../core/masks";
import type { MaskObject, Project } from "../core/model";
import { clipEnd, sourceToTimeline } from "../core/timeline";
import type { Engine } from "../engine/Engine";
import { SamApi } from "../sam/api";
import { estimateUsd, planChunks } from "../sam/plan";
import type { SamProgress } from "../sam/run";
import { runMaskJob } from "../sam/runMask";
import { formatTimecode, type Action } from "./state";

/** 常用目標（SAM 的英文名詞片語；照原專案 FACE_TARGETS） */
const TARGETS: { phrase: string; label: string }[] = [
  { phrase: "human face", label: "Faces" },
  { phrase: "license plate", label: "License plates" },
  { phrase: "name tag", label: "Name tags" },
  { phrase: "text", label: "Text" },
  { phrase: "phone screen", label: "Phone screens" },
  { phrase: "computer monitor", label: "Monitors" },
  { phrase: "QR code", label: "QR codes" },
  { phrase: "person", label: "People" },
];

/** 同意說明的鍵（同意過就不再問） */
const CONSENT_KEY = "wordblade.consent.sam";
/** 取樣率（每秒幾格）的選項 */
const RATES = [5, 10, 15];

/** 讀同意狀態 */
function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "yes";
  } catch {
    return false;
  }
}

/** 遮罩頁籤 */
export function MaskTab({ project, engine, range, playhead, dispatch }: {
  project: Project;
  engine: Engine;
  /** 時間軸選的範圍 */
  range: { start: number; end: number } | null | undefined;
  playhead: number;
  dispatch: Dispatch<Action>;
}) {
  /** 選的常用目標（自己打時是 null） */
  const [preset, setPreset] = useState<string | null>("human face");
  /** 自己打的目標（任何語言） */
  const [custom, setCustom] = useState("");
  const [fps, setFps] = useState(10);
  const [asking, setAsking] = useState(false);
  const [progress, setProgress] = useState<SamProgress | null>(null);
  const [message, setMessage] = useState<{ kind: "info" | "warning" | "error"; text: string } | null>(null);
  /** 執行中的取消控制 */
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  // 範圍：時間軸選的範圍；沒有就用播放頭所在的 V1 片段整段
  const v1 = project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  const clipHere = project.clips.find((c) => c.trackId === v1 && !c.freeze && c.start <= playhead && playhead < clipEnd(c));
  const timelineRange = range ?? (clipHere ? { start: clipHere.start, end: clipEnd(clipHere) } : null);
  const source = timelineRange ? maskSourceRange(project, timelineRange) : null;
  const media = source ? project.media.find((m) => m.id === source.mediaId) : undefined;
  const frames = source ? planChunks(source.start, source.end, fps).map((c) => Math.ceil((c.end - c.start) * fps)) : [];
  const busy = progress !== null;

  /** 按下「Find」：先問同意 */
  const onFind = () => {
    setMessage(null);
    if (!source || !media) return;
    if (!loadSettings().token) {
      setMessage({ kind: "error", text: "Set your invite token in Effects → 2D → AI settings first." });
      return;
    }
    if (!hasConsent()) setAsking(true);
    else void run();
  };

  /** 執行：（必要時翻譯目標）→ 轉小檔 → SAM → 加入遮罩物件 */
  const run = async () => {
    if (!source || !media) return;
    const settings = loadSettings();
    const api = new SamApi(settings);
    const abort = new AbortController();
    abortRef.current = abort;
    const endBusy = beginBusy();
    setProgress({ chunk: 1, chunks: frames.length, stage: "preparing", frames: 0 });
    try {
      let phrase = preset ?? custom.trim();
      if (!preset) {
        phrase = await api.phrase(phrase);
        if (!phrase) throw new GatewayError("That doesn't look like something visible in the video. Try a short noun, e.g. \"license plate\".", 400);
      }
      const result = await runMaskJob({ engine, media, phrase, start: source.start, end: source.end, fps, signal: abort.signal, onProgress: setProgress });
      if (result.objects.length) dispatch({ type: "commit", edits: [{ kind: "addMasks", masks: result.objects }] });
      setMessage(result.objects.length
        ? { kind: result.capped ? "warning" : "info", text: `Found ${result.objects.length} × "${phrase}".${result.capped ? " SAM tracks at most 16 objects at a time — some may be missing; try a shorter range." : ""}` }
        : { kind: "warning", text: `No "${phrase}" found in this range.` });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setMessage({ kind: "info", text: "Cancelled." });
      else setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      endBusy();
      abortRef.current = null;
      setProgress(null);
    }
  };

  /** 同意後接著執行 */
  const accept = () => {
    try {
      localStorage.setItem(CONSENT_KEY, "yes");
    } catch {
      /* 存不了就只在這次有效 */
    }
    setAsking(false);
    void run();
  };

  /** 改一個物件 */
  const update = (m: MaskObject, patch: Partial<MaskObject>) => dispatch({ type: "commit", edits: [{ kind: "setMask", mask: { ...m, ...patch } }] });

  /** 物件出現的第一個時間在時間軸上的位置（用到這支素材的第一個片段） */
  const timelineOf = (m: MaskObject) => {
    for (const c of project.clips) {
      if (c.mediaId !== m.mediaId) continue;
      const t = sourceToTimeline(c, m.samples[0].t);
      if (t !== null) return t;
    }
    return null;
  };

  return (
    <div className="mask-tab" data-testid="mask-tab">
      <h3 className="section-title">Hide something in the video (SAM 3.1)</h3>
      <div className="mask-targets">
        {TARGETS.map((t) => (
          <button key={t.phrase} type="button" className={`example-chip${preset === t.phrase ? " active" : ""}`} data-testid="mask-target" data-phrase={t.phrase} disabled={busy} onClick={() => setPreset(t.phrase)}>{t.label}</button>
        ))}
        <button type="button" className={`example-chip${preset === null ? " active" : ""}`} disabled={busy} onClick={() => setPreset(null)}>Other…</button>
      </div>
      {preset === null && (
        <input className="mask-custom" data-testid="mask-custom" placeholder="e.g. 名牌, credit card, sticky note" value={custom} maxLength={200} disabled={busy} onChange={(e) => setCustom(e.target.value)} />
      )}
      <p className="muted" data-testid="mask-range">
        {source && timelineRange
          ? `${range ? "Selected range" : "Clip at the playhead"}: ${formatTimecode(timelineRange.start).slice(3)}–${formatTimecode(Math.min(timelineRange.end, timelineRange.start + (source.end - source.start))).slice(3)} · ${frames.reduce((a, b) => a + b, 0)} frames · about US$${estimateUsd(frames).toFixed(2)}`
          : "Put the playhead on a clip in V1, or Shift+drag on the timeline to choose a range."}
      </p>
      <div className="vibe-actions">
        <label className="muted">Frames per second <select value={fps} disabled={busy} onChange={(e) => setFps(Number(e.target.value))}>{RATES.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
        <span className="spacer" />
        {busy
          ? <button type="button" data-testid="mask-cancel" onClick={() => abortRef.current?.abort()}>Cancel</button>
          : <button type="button" data-testid="mask-find" disabled={!source || (preset === null && !custom.trim())} onClick={onFind}>Find and mask</button>}
      </div>
      {progress && <p className="muted" data-testid="mask-progress">{progress.stage === "preparing" ? "Preparing the clip…" : `Tracking… ${progress.frames} frames`}{progress.chunks > 1 ? ` (part ${progress.chunk}/${progress.chunks})` : ""}</p>}
      {asking && (
        <div className="consent" data-testid="mask-consent">
          <p>The chosen part of the video ({frames.reduce((a, b) => a + b, 0)} frames, no sound, up to 1280 px wide) will be uploaded to Meta and analysed by SAM 3.1. The upload is deleted when the job ends and expires within 1 hour. Estimated cost: about US${estimateUsd(frames).toFixed(2)}.</p>
          <button type="button" onClick={accept}>Agree and continue</button> <button type="button" onClick={() => setAsking(false)}>Cancel</button>
        </div>
      )}
      {message && <p className={message.kind === "error" ? "error" : message.kind === "warning" ? "warning" : "muted"} data-testid="mask-message">{message.text}</p>}

      <h3 className="section-title">Masks</h3>
      {!project.masks.length ? <p className="muted placeholder" data-testid="mask-empty">No masks yet.</p> : (
        <ul className="mask-list" data-testid="mask-list">
          {project.masks.map((m) => {
            const at = timelineOf(m);
            return (
              <li key={m.id} data-testid="mask-row" data-mask-id={m.id}>
                <label className="mask-name"><input type="checkbox" data-testid="mask-enabled" checked={m.enabled} onChange={(e) => update(m, { enabled: e.target.checked })} /> {m.label}</label>
                <button type="button" className="link" disabled={at === null} onClick={() => at !== null && dispatch({ type: "seek", time: at })}>{at === null ? "—" : formatTimecode(at).slice(3)}</button>
                <select data-testid="mask-effect" value={m.effect.kind} onChange={(e) => update(m, { effect: { ...m.effect, kind: e.target.value as MaskObject["effect"]["kind"] } })}>
                  <option value="mosaic">Mosaic</option>
                  <option value="blur">Blur</option>
                  <option value="solid">Solid</option>
                </select>
                {m.effect.kind === "solid"
                  ? <input type="color" data-testid="mask-color" value={m.effect.color ?? "#000000"} onChange={(e) => update(m, { effect: { ...m.effect, color: e.target.value } })} />
                  : <input type="range" data-testid="mask-strength" title="Strength" min={4} max={120} value={m.effect.strength} onChange={(e) => update(m, { effect: { ...m.effect, strength: Number(e.target.value) } })} />}
                <input type="range" data-testid="mask-expand" title="Grow the mask" min={0} max={50} value={m.expand} onChange={(e) => update(m, { expand: Number(e.target.value) })} />
                <button type="button" data-testid="mask-delete" title="Delete" onClick={() => dispatch({ type: "commit", edits: [{ kind: "deleteMasks", ids: [m.id] }] })}>✕</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
