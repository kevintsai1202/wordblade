// AI 導演頁籤（spec §5.11，P1-1）：選一支有聲的影片 → 估計用量與同意說明 → Ask the director（沒有逐字稿先自動轉錄）→
// 逐段轉 480p 小檔上傳、閘道逐段分析與統籌 → 建議清單（依時間）。點一條：跳到那裡並選取時間軸範圍；Enter 採用、Esc 略過。
// 採用：剪、改字、放大是一筆編輯；遮隱私跑 SAM、加特效跑 Vibe、運鏡加 Wonder 挑的 3D 場景（漂浮板子再跑「用說的」），AI 完成後一次寫入。
// 每次採用連同建議狀態是一筆可復原的編輯。
import { useEffect, useRef, useState, type Dispatch, type KeyboardEvent } from "react";
import { GatewayClient, GatewayError, loadSettings } from "../ai/gateway";
import { runPlane3d, type BoardParams } from "../ai/plane3d";
import { runVibe } from "../ai/vibe";
import type { PluginService } from "../anim/pluginService";
import { transcribeMedia } from "../asr/transcribe";
import type { Envelope } from "../audio/envelope";
import { beginBusy } from "../core/busy";
import type { Edit } from "../core/history";
import type { Media, Project, Suggestion } from "../core/model";
import { clipEnd } from "../core/timeline";
import { DirectorApi } from "../director/api";
import { estimateTokens, runDirector, type DirectorProgress } from "../director/run";
import { adoptEdits, maskFromBox, maskNeedsSam, suggestionSpan } from "../director/suggestions";
import type { Engine } from "../engine/Engine";
import { makeSamClip } from "../sam/clip";
import { runMaskJob } from "../sam/runMask";
import { TEMPLATES_3D, builtinPlugins3D, template3DEffect } from "../three/builtins";
import { captureFrame } from "./capture";
import { FPS, formatTimecode, type Action } from "./state";

/** 同意說明的鍵（同意過就不再問）；同意時一併同意導演會用到的遮罩、Vibe、用說的 */
const CONSENT_KEY = "wordblade.consent.director";
const RELATED_CONSENTS = ["wordblade.consent.sam", "wordblade.consent.vibe", "wordblade.consent.plane3d"];

/** 各種建議的標籤 */
const KIND_LABEL: Record<Suggestion["kind"], string> = { cut: "✂ Cut", mask: "🛡 Mask", effect: "✨ Effect", camera: "🎥 Camera", fix: "✎ Fix", zoom: "🔍 Zoom" };

/** 讀同意狀態 */
function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "yes";
  } catch {
    return false;
  }
}

/** 一條建議的細節（遮什麼、什麼特效、改成什麼） */
function detail(s: Suggestion): string {
  const p = s.payload;
  if (s.kind === "mask") return String(p.target ?? "");
  if (s.kind === "effect") return String(p.description ?? "");
  if (s.kind === "camera") return `${TEMPLATES_3D.find((t) => t.id === p.scene)?.title ?? String(p.scene)} — ${String(p.description ?? "")}`;
  if (s.kind === "fix") return `→ ${String(p.text ?? "")}`;
  return "";
}

/** AI 導演頁籤 */
export function DirectorTab({ project, engine, envelopes, plugins, playhead, dispatch }: {
  project: Project;
  engine: Engine;
  envelopes: Map<string, Envelope>;
  plugins: PluginService;
  playhead: number;
  dispatch: Dispatch<Action>;
}) {
  // 可以跑的素材：有聲的影片；預設播放頭所在的 V1 片段那支
  const candidates = project.media.filter((m) => m.kind === "video" && m.audio);
  const v1 = project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  const here = project.clips.find((c) => c.trackId === v1 && c.start <= playhead && playhead < clipEnd(c))?.mediaId;
  const [mediaId, setMediaId] = useState<string | null>(null);
  const media: Media | undefined = candidates.find((m) => m.id === (mediaId ?? here)) ?? candidates[0];
  const [asking, setAsking] = useState(false);
  const [progress, setProgress] = useState<DirectorProgress | { stage: "transcribing"; done: number; total: number } | null>(null);
  const [message, setMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  /** 選取的建議與正在採用的建議 */
  const [selected, setSelected] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const suggestions = media ? project.suggestions.filter((s) => s.mediaId === media.id).sort((a, b) => a.start - b.start) : [];
  const hasWords = media ? project.words.some((w) => w.mediaId === media.id) : false;
  const busy = progress !== null;
  /** 可以開始：有逐字稿，或音量包絡已經好了（自動轉錄要用） */
  const ready = !!media && (hasWords || envelopes.has(media.id));

  /** 按下 Ask：先問同意 */
  const onAsk = () => {
    setMessage(null);
    if (!media) return;
    if (!loadSettings().token) {
      setMessage({ kind: "error", text: "Set your invite token in Effects → 2D → AI settings first." });
      return;
    }
    if (!hasConsent()) setAsking(true);
    else void run();
  };

  /** 同意後執行 */
  const accept = () => {
    try {
      for (const key of [CONSENT_KEY, ...RELATED_CONSENTS]) localStorage.setItem(key, "yes");
    } catch {
      /* 存不了就只在這次有效 */
    }
    setAsking(false);
    void run();
  };

  /** 執行：（沒有逐字稿先轉錄）→ 逐段轉檔上傳 → 等建議 → 寫進專案 */
  const run = async () => {
    if (!media) return;
    const settings = loadSettings();
    const abort = new AbortController();
    abortRef.current = abort;
    const endBusy = beginBusy();
    try {
      let words = project.words.filter((w) => w.mediaId === media.id);
      if (!words.length) {
        const env = envelopes.get(media.id);
        if (!env) throw new Error("This video is still being prepared — try again in a moment.");
        setProgress({ stage: "transcribing", done: 0, total: 1 });
        const gateway = new GatewayClient(settings);
        const result = await transcribeMedia(media, env, (m, s, e) => engine.extractAsrAudio(m, s, e), (wav) => gateway.transcribe(wav), (p) => setProgress({ stage: "transcribing", ...p }));
        words = result.words;
        dispatch({ type: "commit", edits: [{ kind: "setWords", mediaId: media.id, words }] });
      }
      // 桌面有 540p 代理檔就從代理檔轉（2026-10-28 實測快 4 倍），否則用原檔
      const src = media.proxyPath ? engine.mediaUrl(media) : await engine.exportSource(media);
      setProgress({ stage: "converting", done: 0, total: 1 });
      const list = await runDirector({
        media, words, scenes: TEMPLATES_3D.map((t) => ({ id: t.id, name: t.name })), api: new DirectorApi(settings), signal: abort.signal, onProgress: setProgress,
        makeClip: async (s, e) => (await makeSamClip(src, s, e, { fps: 2, maxWidth: Infinity, maxHeight: 480, bitrate: 250_000, scan: false, videoW: media.width ?? 1920, videoH: media.height ?? 1080, signal: abort.signal })).bytes,
      });
      dispatch({ type: "commit", edits: [{ kind: "setSuggestions", mediaId: media.id, suggestions: list }] });
      setMessage({ kind: "info", text: list.length ? `${list.length} suggestions. Click one to preview; Enter to apply, Esc to skip.` : "The director has no suggestions for this video." });
      setSelected(list[0]?.id ?? null);
      listRef.current?.focus();
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") setMessage({ kind: "info", text: "Cancelled." });
      else setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      endBusy();
      abortRef.current = null;
      setProgress(null);
    }
  };

  /** 選一條：跳到那裡、選取時間軸範圍（預覽與範圍動作都用它） */
  const select = (s: Suggestion) => {
    setSelected(s.id);
    const span = suggestionSpan(project, s);
    if (!span) return;
    dispatch({ type: "seek", time: span.start });
    dispatch({ type: "setRange", start: span.start, end: span.end });
  };

  /** 採用一條 */
  const adopt = async (s: Suggestion) => {
    if (s.status !== "pending" || adopting) return;
    setMessage(null);
    const status: Edit = { kind: "setSuggestionStatus", id: s.id, status: "applied" };
    const sync = adoptEdits(project, s);
    if (sync) {
      dispatch({ type: "commit", edits: sync });
      return;
    }
    if (s.kind === "cut" || s.kind === "fix" || s.kind === "zoom") {
      setMessage({ kind: "error", text: "This suggestion no longer matches the transcript." });
      return;
    }
    const media = project.media.find((m) => m.id === s.mediaId);
    const span = suggestionSpan(project, s);
    if (!media || (s.kind !== "mask" && !span)) {
      setMessage({ kind: "error", text: "This part of the video is no longer on the timeline." });
      return;
    }
    setAdopting(s.id);
    const endBusy = beginBusy();
    try {
      const settings = loadSettings();
      if (s.kind === "mask") {
        // 螢幕上的文字（金鑰、Email…）SAM 找不到：直接用 Spark 回報的框遮；人、臉、車牌等跑 SAM，找不到再退回框
        const boxMask = maskFromBox(s, `mask-${crypto.randomUUID().slice(0, 8)}`);
        let masks = boxMask && !maskNeedsSam(s) ? [boxMask] : [];
        if (!masks.length) {
          const result = await runMaskJob({ engine, media, phrase: String(s.payload.target), start: s.start, end: s.end, fps: 10 });
          masks = result.objects.length ? result.objects : boxMask ? [boxMask] : [];
        }
        if (!masks.length) throw new Error(`No "${String(s.payload.target)}" found in this part — nothing to mask.`);
        dispatch({ type: "commit", edits: [{ kind: "addMasks", masks }, status] });
      } else if (s.kind === "effect") {
        const outcome = await runVibe(new GatewayClient(settings), plugins.host, await plugins.builtins(), {
          description: String(s.payload.description), screenshot: captureFrame(), start: span!.start, duration: span!.end - span!.start,
          box: { cx: 0.5, cy: 0.5, w: 0.3, h: 0.2 }, aspect: 16 / 9, fps: FPS, effectId: `fx-${crypto.randomUUID().slice(0, 8)}`,
        }, () => undefined);
        if (!outcome.ok) throw new Error(outcome.message);
        dispatch({ type: "commit", edits: [{ kind: "addEffect", effect: outcome.effect, plugins: outcome.plugins }, status] });
      } else if (s.kind === "camera") {
        const template = TEMPLATES_3D.find((t) => t.id === s.payload.scene);
        if (!template) throw new Error("Unknown 3D scene.");
        const plugin = (await builtinPlugins3D()).get(template.componentId)!;
        const effect = template3DEffect(template, plugin, `fx-${crypto.randomUUID().slice(0, 8)}`, span!.start, span!.end - span!.start);
        // 漂浮板子：再請「用說的」照建議的描述調運鏡（失敗就用範本原本的運鏡）
        if (template.componentId === "floating-board") {
          const outcome = await runPlane3d(new GatewayClient(settings), {
            description: String(s.payload.description), screenshot: captureFrame(), current: effect.params.params as BoardParams, length: effect.end - effect.start, width: 1920, height: 1080,
          });
          if (outcome.ok) effect.params = { ...effect.params, params: outcome.params };
        }
        dispatch({ type: "commit", edits: [{ kind: "addEffect", effect, plugins: [plugin] }, status] });
      }
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof GatewayError || e instanceof Error ? e.message : String(e) });
    } finally {
      endBusy();
      setAdopting(null);
    }
  };

  /** 略過 */
  const skip = (s: Suggestion) => {
    if (s.status === "pending") dispatch({ type: "commit", edits: [{ kind: "setSuggestionStatus", id: s.id, status: "skipped" }] });
  };

  /** 清單上的鍵盤：↑↓ 換一條、Enter 採用、Esc 略過（攔下全域熱鍵：Esc 不清掉剛選的範圍） */
  const onKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const i = suggestions.findIndex((s) => s.id === selected);
    const cur = suggestions[i];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const next = suggestions[Math.min(suggestions.length - 1, Math.max(0, i + (e.key === "ArrowDown" ? 1 : -1)))];
      if (next) select(next);
    } else if (e.key === "Enter" && cur) {
      void adopt(cur);
    } else if (e.key === "Escape" && cur) {
      skip(cur);
      const next = suggestions.slice(i + 1).find((s) => s.status === "pending");
      if (next) select(next);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const progressText = !progress ? "" : progress.stage === "transcribing" ? `Transcribing… ${progress.done}/${progress.total}`
    : progress.stage === "converting" ? `Preparing part ${progress.done + 1}…`
    : progress.stage === "analysing" ? `The AI is watching… ${progress.done}/${progress.total} parts`
    : "The director is putting the suggestions together…";

  return (
    <div className="director-tab" data-testid="director-tab">
      <h3 className="section-title">AI Director</h3>
      {!candidates.length ? <p className="muted placeholder">Import a video with sound first.</p> : (
        <>
          <div className="vibe-actions">
            <select data-testid="director-media" value={media?.id ?? ""} disabled={busy} onChange={(e) => setMediaId(e.target.value)}>
              {candidates.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
            </select>
            <span className="spacer" />
            {busy
              ? <button type="button" data-testid="director-cancel" onClick={() => abortRef.current?.abort()}>Cancel</button>
              : <button type="button" data-testid="director-ask" disabled={!ready} title={ready ? undefined : "Still preparing this video (audio levels for transcription)"} onClick={onAsk}>{suggestions.length ? "Ask again" : "Ask the director"}</button>}
          </div>
          {media && <p className="muted" data-testid="director-estimate">{formatTimecode(media.duration).slice(3)} · about {Math.round(estimateTokens(media.duration) / 1000)}k tokens{hasWords ? "" : " · will transcribe first"}</p>}
        </>
      )}
      {progress && <p className="muted" data-testid="director-progress">{progressText}</p>}
      {asking && (
        <div className="consent" data-testid="director-consent">
          <p>The video (split into parts, no sound, 480p, 2 frames per second) and its transcript will be sent to the WordBlade AI service and Meta. Muse Spark (Contributor version — content may be used to train Meta's models) watches each part; Muse Wonder writes the suggestions. Applying a mask, effect or camera suggestion later sends that part again to SAM 3.1, Vibe or the camera AI.</p>
          <button type="button" onClick={accept}>Agree and continue</button> <button type="button" onClick={() => setAsking(false)}>Cancel</button>
        </div>
      )}
      {message && <p className={message.kind === "error" ? "error" : "muted"} data-testid="director-message">{message.text}</p>}
      {suggestions.length > 0 && (
        <ul className="director-list" data-testid="director-list" tabIndex={0} ref={listRef} onKeyDown={onKey}>
          {suggestions.map((s) => {
            const span = suggestionSpan(project, s);
            return (
              <li key={s.id} data-testid="director-row" data-kind={s.kind} data-status={s.status} data-start={s.start.toFixed(2)} data-end={s.end.toFixed(2)} className={`${s.id === selected ? "selected " : ""}${s.status}`} onClick={() => select(s)}>
                <span className="director-kind">{KIND_LABEL[s.kind]}</span>
                <span className="timecode">{span ? formatTimecode(span.start).slice(3) : "—"}</span>
                <span className="director-reason">{s.reason}{detail(s) && <span className="muted"> · {detail(s)}</span>}</span>
                {s.status === "pending" ? (
                  <span className="director-actions">
                    <button type="button" data-testid="director-adopt" disabled={adopting !== null || (s.kind !== "mask" && s.kind !== "cut" && s.kind !== "fix" && s.kind !== "zoom" && !span)} onClick={(e) => { e.stopPropagation(); void adopt(s); }}>{adopting === s.id ? "…" : "Apply"}</button>
                    <button type="button" data-testid="director-skip" disabled={adopting !== null} onClick={(e) => { e.stopPropagation(); skip(s); }}>Skip</button>
                  </span>
                ) : <span className="muted director-status">{s.status === "applied" ? "Applied" : "Skipped"}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
