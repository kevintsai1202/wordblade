// AI 導演頁籤（spec §5.11；docs/plan-10-29-director2.md）：選一支有聲的影片 → 估計用量與同意說明 → Ask the director（沒有逐字稿先自動轉錄）→
// 逐段算畫面變化區、轉 480p 小檔上傳（Spark 理解）→ Wonder 規劃剪輯腳本 → 拼縮圖總表送審（另一個 Wonder 獨立審查，有退回就改一輪）→
// 剪輯腳本依章節顯示：每項有目的、引用的旁白與審查意見，預設勾選審查通過的；審查刪掉的灰色列在最後。
// 「套用勾選的項目」一次套用（apply.ts：剪、改字、遮罩、放大 → 特效、3D → 字幕、配樂 → 片頭），合成一筆編輯、一次 Ctrl+Z 復原；
// 也可以點一條跳過去，逐條 Apply／Skip（Enter／Esc）。
import { useEffect, useMemo, useRef, useState, type Dispatch, type KeyboardEvent } from "react";
import { GatewayClient, loadSettings } from "../ai/gateway";
import type { PluginService } from "../anim/pluginService";
import { transcribeMedia } from "../asr/transcribe";
import type { Envelope } from "../audio/envelope";
import { beginBusy } from "../core/busy";
import type { Media, Project, Suggestion } from "../core/model";
import { clipEnd } from "../core/timeline";
import { findActivities, sampleLuma } from "../director/activity";
import { DirectorApi, type DirectorStyle, type DirectorTreatment } from "../director/api";
import { applyScript } from "../director/apply";
import { buildContactSheet, buildFrameSheet, frameSource, makeApplyDeps } from "../director/browser";
import { estimateTokens, runDirector, type DirectorProgress } from "../director/run";
import { suggestionSpan } from "../director/suggestions";
import type { Engine, ImportSource } from "../engine/Engine";
import { makeSamClip } from "../sam/clip";
import { TEMPLATES_3D } from "../three/builtins";
import { FPS, formatTimecode, type Action } from "./state";

/** 同意說明的鍵（同意過就不再問）；同意時一併同意導演會用到的遮罩、Vibe、用說的、配樂 */
const CONSENT_KEY = "wordblade.consent.director";
const RELATED_CONSENTS = ["wordblade.consent.asr", "wordblade.consent.sam", "wordblade.consent.vibe", "wordblade.consent.plane3d", "wordblade.consent.audio"];

/** 各種項目的標籤 */
const KIND_LABEL: Record<Suggestion["kind"], string> = {
  cut: "✂ Cut", mask: "🛡 Mask", effect: "✨ Effect", camera: "🎬 Transition", transition: "🎬 Transition", mascot: "🧸 Mascot",
  fix: "✎ Fix", zoom: "🔍 Zoom", captionStyle: "💬 Captions", music: "🎵 Music", intro: "🎞 Intro", note: "📝 Note",
};

/** 整支片的項目（不屬於某個章節） */
const WHOLE_VIDEO = new Set<Suggestion["kind"]>(["captionStyle", "music", "intro"]);

/** 畫面變化偵測的取樣間隔（秒） */
const ACTIVITY_STEP = 1;

/** 讀同意狀態 */
function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "yes";
  } catch {
    return false;
  }
}

/** 一項的細節（遮什麼、什麼特效、改成什麼、哪個場景、配樂描述、片頭標題） */
function detail(s: Suggestion): string {
  const p = s.payload;
  if (s.kind === "mask") return String(p.target ?? "");
  if (s.kind === "effect" || s.kind === "music") return String(p.description ?? "");
  if (s.kind === "camera" || s.kind === "transition") return TEMPLATES_3D.find((t) => t.id === p.scene)?.title ?? String(p.scene);
  if (s.kind === "fix") return `→ ${String(p.text ?? "")}`;
  if (s.kind === "captionStyle") return `karaoke: ${String(p.karaoke)}`;
  if (s.kind === "intro") return `“${String(p.title)}”${p.subtitle ? ` — ${String(p.subtitle)}` : ""}`;
  return "";
}

/** 審查結果的標記 */
function reviewBadge(s: Suggestion): string {
  if (!s.review) return "";
  return { keep: "✓ reviewed", revised: "✎ revised by review", added: "＋ added by review", prune: "− reviewer: could go", drop: "✕ removed by review" }[s.review.verdict];
}

/** 風格選項（docs/plan-10-30-director3.md）：plain 是螢幕教學片的預設 */
const STYLES: { id: DirectorStyle; label: string }[] = [
  { id: "plain", label: "Plain — cuts, fixes, masks, zooms" },
  { id: "light", label: "Light — plus callouts and music" },
  { id: "playful", label: "Playful — plus 3D transitions and mascot" },
];

/** AI 導演頁籤 */
export function DirectorTab({ project, engine, envelopes, plugins, playhead, importSources, dispatch }: {
  project: Project;
  engine: Engine;
  envelopes: Map<string, Envelope>;
  plugins: PluginService;
  playhead: number;
  importSources: (sources: ImportSource[]) => Promise<Media[]>;
  dispatch: Dispatch<Action>;
}) {
  // 可以跑的素材：有聲的影片；預設播放頭所在的 V1 片段那支
  const candidates = project.media.filter((m) => m.kind === "video" && m.audio);
  const v1 = project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  const here = project.clips.find((c) => c.trackId === v1 && c.start <= playhead && playhead < clipEnd(c))?.mediaId;
  const [mediaId, setMediaId] = useState<string | null>(null);
  const media: Media | undefined = candidates.find((m) => m.id === (mediaId ?? here)) ?? candidates[0];
  const [asking, setAsking] = useState(false);
  const [progress, setProgress] = useState<DirectorProgress | { stage: "transcribing" | "applying"; done: number; total: number } | null>(null);
  const [message, setMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  /** 選取的項目、正在套用的項目、沒勾的項目 */
  const [selected, setSelected] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  /** 風格與這次的導演構想（構想只在這次執行後顯示，不存進專案） */
  const [style, setStyle] = useState<DirectorStyle>("plain");
  const [treatment, setTreatment] = useState<DirectorTreatment | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** 最新的專案（套用時各步驟要讀） */
  const projectRef = useRef(project);
  projectRef.current = project;
  useEffect(() => () => abortRef.current?.abort(), []);

  const suggestions = media ? project.suggestions.filter((s) => s.mediaId === media.id).sort((a, b) => a.start - b.start) : [];
  const chapters = useMemo(() => (media ? (project.directorChapters ?? []).filter((c) => c.mediaId === media.id) : []), [project.directorChapters, media]);
  const hasWords = media ? project.words.some((w) => w.mediaId === media.id) : false;
  const busy = progress !== null;
  /** 可以開始：有逐字稿，或音量包絡已經好了（自動轉錄要用） */
  const ready = !!media && (hasWords || envelopes.has(media.id));
  /** 預設勾選：還沒處理、審查沒刪掉的 */
  const checked = suggestions.filter((s) => s.status === "pending" && s.kind !== "note" && !unchecked.has(s.id));

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

  /** 執行：（沒有逐字稿先轉錄）→ 理解、規劃、審查 → 剪輯腳本與章節寫進專案 */
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
      const src = await frameSource(engine, media);
      setProgress({ stage: "converting", done: 0, total: 1 });
      const result = await runDirector({
        media, words, scenes: TEMPLATES_3D.map((t) => ({ id: t.id, name: t.name })), api: new DirectorApi(settings), signal: abort.signal, onProgress: setProgress, style,
        makeClip: async (s, e) => (await makeSamClip(src, s, e, { fps: 2, maxWidth: Infinity, maxHeight: 480, bitrate: 250_000, scan: false, videoW: media.width ?? 1920, videoH: media.height ?? 1080, signal: abort.signal })).bytes,
        activities: async (s, e) => {
          const times: number[] = [];
          for (let t = s; t < e; t += ACTIVITY_STEP) times.push(Math.round(t * 100) / 100);
          return findActivities(await sampleLuma(src, times));
        },
        contactSheet: (items) => buildContactSheet(src, items),
        planSheet: (cells) => buildFrameSheet(src, cells),
      });
      dispatch({ type: "commit", edits: [{ kind: "setSuggestions", mediaId: media.id, suggestions: result.suggestions, chapters: result.chapters }] });
      // 審查員點名可有可無的項目預設不勾
      setUnchecked(new Set(result.suggestions.filter((s) => s.review?.verdict === "prune").map((s) => s.id)));
      setTreatment(result.treatment);
      const pending = result.suggestions.filter((s) => s.status === "pending").length;
      const removed = result.suggestions.length - pending;
      setMessage({ kind: "info", text: pending ? `${pending} edits in ${result.chapters.length} chapters${removed ? ` (${removed} removed by review)` : ""}. Check what you want and apply — or click one to preview.` : "The director has no suggestions for this video." });
      setSelected(result.suggestions.find((s) => s.status === "pending")?.id ?? null);
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

  /** 套用一批（一筆編輯、一次 Ctrl+Z）；失敗的項目留著並說明 */
  const applyItems = async (items: Suggestion[], single: string | null) => {
    if (!media || !items.length || adopting) return;
    setMessage(null);
    setAdopting(single ?? "batch");
    const endBusy = beginBusy();
    try {
      const deps = makeApplyDeps({
        project: () => projectRef.current, engine, plugins, media, chapters, settings: loadSettings(), importSources, fps: FPS,
        onProgress: single ? undefined : (done, total) => setProgress({ stage: "applying", done, total }),
      });
      const { edits, failed } = await applyScript(projectRef.current, items, deps);
      if (edits.length) dispatch({ type: "commit", edits });
      const ok = items.length - failed.length;
      if (failed.length) {
        const names = failed.map((f) => `${KIND_LABEL[items.find((s) => s.id === f.id)!.kind]}: ${f.message}`).join(" · ");
        setMessage({ kind: "error", text: `${ok ? `Applied ${ok}. ` : ""}Couldn't apply ${failed.length}: ${names}` });
      } else if (!single) {
        setMessage({ kind: "info", text: `Applied ${ok} edits. Ctrl+Z undoes them all at once.` });
      }
    } catch (e) {
      setMessage({ kind: "error", text: e instanceof Error ? e.message : String(e) });
    } finally {
      endBusy();
      setAdopting(null);
      setProgress(null);
    }
  };

  /** 採用一條 */
  const adopt = (s: Suggestion) => (s.status === "pending" ? applyItems([s], s.id) : undefined);

  /** 略過 */
  const skip = (s: Suggestion) => {
    if (s.status === "pending") dispatch({ type: "commit", edits: [{ kind: "setSuggestionStatus", id: s.id, status: "skipped" }] });
  };

  /** 勾選切換 */
  const toggle = (id: string) => setUnchecked((set) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  /** 清單上的鍵盤：↑↓ 換一條、Enter 採用、Esc 略過、空白鍵勾選（攔下全域熱鍵：Esc 不清掉剛選的範圍） */
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
    } else if (e.key === " " && cur && cur.status === "pending") {
      toggle(cur.id);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };

  const progressText = !progress ? "" : progress.stage === "transcribing" ? `Transcribing… ${progress.done}/${progress.total}`
    : progress.stage === "converting" ? `① Preparing part ${progress.done + 1} (looking for typing on screen)…`
    : progress.stage === "analysing" ? `② The AI is watching… ${progress.done}/${progress.total} parts`
    : progress.stage === "planning" ? "③ The director is planning the edit…"
    : progress.stage === "reviewing" ? "④ An independent reviewer is checking the plan against the frames…"
    : `Applying… ${progress.done}/${progress.total}`;

  /** 依章節分組（整支片的項目一組、沒章節的一組、審查刪掉的最後） */
  const groups: { key: string; title: string; items: Suggestion[] }[] = [];
  const live = suggestions.filter((s) => s.review?.verdict !== "drop");
  const whole = live.filter((s) => WHOLE_VIDEO.has(s.kind));
  if (whole.length) groups.push({ key: "whole", title: "Whole video", items: whole });
  chapters.forEach((c, i) => {
    const items = live.filter((s) => !WHOLE_VIDEO.has(s.kind) && (s.chapter === i || (s.chapter === undefined || s.chapter < 0 ? s.start >= c.start && s.start < c.end : false)));
    groups.push({ key: `c${i}`, title: `${i + 1}. ${c.title} · ${formatTimecode(c.start).slice(3, 8)}`, items });
  });
  const grouped = new Set(groups.flatMap((g) => g.items.map((s) => s.id)));
  const rest = live.filter((s) => !grouped.has(s.id));
  if (rest.length) groups.push({ key: "rest", title: chapters.length ? "Other" : "Suggestions", items: rest });
  const removed = suggestions.filter((s) => s.review?.verdict === "drop");
  if (removed.length) groups.push({ key: "removed", title: "Removed by review", items: removed });

  /** 一列 */
  const row = (s: Suggestion) => {
    const span = suggestionSpan(project, s);
    const pending = s.status === "pending";
    return (
      <li key={s.id} data-testid="director-row" data-kind={s.kind} data-status={s.status} data-review={s.review?.verdict ?? ""} data-start={s.start.toFixed(2)} data-end={s.end.toFixed(2)}
        className={`${s.id === selected ? "selected " : ""}${s.status}`} onClick={() => select(s)}>
        {pending && s.kind !== "note"
          ? <input type="checkbox" data-testid="director-check" checked={!unchecked.has(s.id)} onClick={(e) => e.stopPropagation()} onChange={() => toggle(s.id)} />
          : <span className="director-check-spacer" />}
        <span className="director-kind">{KIND_LABEL[s.kind]}</span>
        <span className="timecode">{WHOLE_VIDEO.has(s.kind) ? "all" : span ? formatTimecode(span.start).slice(3) : "—"}</span>
        <span className="director-reason">
          {s.purpose ?? s.reason}{detail(s) && <span className="muted"> · {detail(s)}</span>}
          {s.quote && <span className="director-quote">“{s.quote}”</span>}
          {s.review && <span className={`director-review ${s.review.verdict}`} title={s.review.note}>{reviewBadge(s)}{s.review.note && s.review.verdict !== "keep" ? `: ${s.review.note}` : ""}</span>}
        </span>
        {pending ? (
          <span className="director-actions">
            {/* 提醒只給人看：沒有 Apply，Skip 叫 Dismiss */}
            {s.kind !== "note" && <button type="button" data-testid="director-adopt" disabled={adopting !== null} onClick={(e) => { e.stopPropagation(); void adopt(s); }}>{adopting === s.id ? "…" : "Apply"}</button>}
            <button type="button" data-testid="director-skip" disabled={adopting !== null} onClick={(e) => { e.stopPropagation(); skip(s); }}>{s.kind === "note" ? "Dismiss" : "Skip"}</button>
          </span>
        ) : <span className="muted director-status">{s.status === "applied" ? "Applied" : "Skipped"}</span>}
      </li>
    );
  };

  return (
    <div className="director-tab" data-testid="director-tab">
      <h3 className="section-title">AI Director</h3>
      {!candidates.length ? <p className="muted placeholder">Import a video with sound first.</p> : (
        <>
          <div className="vibe-actions">
            <select data-testid="director-media" value={media?.id ?? ""} disabled={busy} onChange={(e) => { setMediaId(e.target.value); setTreatment(null); }}>
              {candidates.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
            </select>
            <select data-testid="director-style" value={style} disabled={busy} title="What kinds of edit the director may use" onChange={(e) => setStyle(e.target.value as DirectorStyle)}>
              {STYLES.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
            <span className="spacer" />
            {busy && progress?.stage !== "applying"
              ? <button type="button" data-testid="director-cancel" onClick={() => abortRef.current?.abort()}>Cancel</button>
              : <button type="button" data-testid="director-ask" disabled={!ready || busy} title={ready ? undefined : "Still preparing this video (audio levels for transcription)"} onClick={onAsk}>{suggestions.length ? "Ask again" : "Ask the director"}</button>}
          </div>
          {media && <p className="muted" data-testid="director-estimate">{formatTimecode(media.duration).slice(3)} · about {Math.round(estimateTokens(media.duration) / 1000)}k tokens{hasWords ? "" : " · will transcribe first"}</p>}
        </>
      )}
      {progress && <p className="muted" data-testid="director-progress">{progressText}</p>}
      {asking && (
        <div className="consent" data-testid="director-consent">
          <p>The video (split into parts, no sound, 480p, 2 frames per second), a sheet of still frames and the transcript will be sent to the WordBlade AI service and Meta. Muse Spark (Contributor version — content may be used to train Meta's models) watches each part; Muse Wonder plans the edit and a second Muse Wonder reviews it. If there is no transcript yet, the audio is transcribed first with Muse Voice Transcribe. Applying masks, effects or music later sends that part again to SAM 3.1 (or Muse Spark for on-screen text), Vibe or the music AI.</p>
          <button type="button" onClick={accept}>Agree and continue</button> <button type="button" onClick={() => setAsking(false)}>Cancel</button>
        </div>
      )}
      {message && <p className={message.kind === "error" ? "error" : "muted"} data-testid="director-message">{message.text}</p>}
      {treatment?.problems?.length ? (
        <details className="director-treatment" data-testid="director-treatment">
          <summary>Director's notes{treatment.audience ? ` — for ${treatment.audience}` : ""}</summary>
          <ul>{treatment.problems.map((p) => <li key={p.id}><span className="timecode">{formatTimecode(p.start).slice(3, 8)}</span> {p.what}</li>)}</ul>
        </details>
      ) : null}
      {checked.length > 0 && (
        <div className="vibe-actions">
          <span className="muted">{checked.length} checked</span>
          <span className="spacer" />
          <button type="button" className="primary" data-testid="director-apply-checked" disabled={adopting !== null || busy} onClick={() => void applyItems(checked, null)}>{adopting === "batch" ? "Applying…" : `Apply ${checked.length} checked`}</button>
        </div>
      )}
      {suggestions.length > 0 && (
        <ul className="director-list" data-testid="director-list" tabIndex={0} ref={listRef} onKeyDown={onKey}>
          {groups.map((g) => (
            <li key={g.key} className={`director-group${g.key === "removed" ? " removed" : ""}`} data-testid="director-chapter">
              <div className="director-group-title">{g.title}</div>
              <ul>{g.items.length ? g.items.map(row) : <li className="muted director-empty">No edits in this chapter.</li>}</ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
