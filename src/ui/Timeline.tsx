import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type Dispatch, type MouseEvent as ReactMouseEvent, type ReactNode, type WheelEvent } from "react";
import type { Envelope } from "../audio/envelope";
import type { Caption } from "../core/captions";
import type { Clip, Effect, Project, Track } from "../core/model";
import { clipDuration, clipEnd, timelineToSource } from "../core/timeline";
import type { ThumbStore } from "../media/thumbStore";
import { formatTimecode, projectDuration, snapTime, type Action, type AppState } from "./state";
import type { Library } from "./useMediaLibrary";
import { ZoomBands, type ZoomEdit } from "./ZoomBands";

/** 片段兩端可以抓來修邊的寬度（像素） */
const EDGE_GRAB = 6;
/** 吸附距離（像素） */
const SNAP_PX = 8;
/** 滑鼠移動少於這個距離（像素）就當成點選，不算拖曳 */
const DRAG_MIN_PX = 3;

/** 拖曳中的狀態：移動片段，或拖入點／出點修邊 */
interface DragState {
  clipId: string;
  mode: "move" | "in" | "out";
  startX: number;
  /** 目前滑鼠的 X */
  x: number;
}

/** 拖曳中的特效標籤：移動，或拖起點／終點修邊 */
interface EffectDrag {
  effectId: string;
  mode: "move" | "in" | "out";
  startX: number;
  x: number;
}

/** 依拖曳距離算出特效的新起點（移動）或新邊界時間（修邊），並套用吸附 */
function effectDragTarget(drag: EffectDrag, effect: Effect, state: AppState): number {
  const dt = (drag.x - drag.startX) / state.pxPerSecond;
  const threshold = SNAP_PX / state.pxPerSecond;
  if (drag.mode === "move") {
    const start = Math.max(0, effect.start + dt);
    const snapped = snapTime(start, state, threshold);
    return snapped !== start ? snapped : snapTime(start + (effect.end - effect.start), state, threshold) - (effect.end - effect.start);
  }
  return snapTime((drag.mode === "in" ? effect.start : effect.end) + dt, state, threshold);
}

/** 依拖曳距離算出片段的新起點（移動）或新邊界時間（修邊），並套用吸附 */
function dragTarget(drag: DragState, clip: Clip, state: AppState): number {
  const dt = (drag.x - drag.startX) / state.pxPerSecond;
  const threshold = SNAP_PX / state.pxPerSecond;
  if (drag.mode === "move") {
    // 起點或終點任一個靠近吸附點就吸過去
    const start = Math.max(0, clip.start + dt);
    const snappedStart = snapTime(start, state, threshold, clip.id);
    if (snappedStart !== start) return snappedStart;
    const end = start + clipDuration(clip);
    return snapTime(end, state, threshold, clip.id) - clipDuration(clip);
  }
  const edge = drag.mode === "in" ? clip.start : clipEnd(clip);
  return snapTime(edge + dt, state, threshold, clip.id);
}

/** 波形畫布最寬幾像素（再寬就用 CSS 拉伸，避免超過畫布上限） */
const WAVE_MAX_PX = 4096;

/** 音訊片段的波形：畫出片段素材範圍內的音量包絡 */
function Waveform({ envelope, clip, width }: { envelope: Envelope; clip: Clip; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const px = Math.max(1, Math.min(WAVE_MAX_PX, Math.round(width)));
  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const h = canvas.height;
    ctx.clearRect(0, 0, px, h);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    const from = clip.srcIn * envelope.rate;
    const span = (clip.srcOut - clip.srcIn) * envelope.rate;
    for (let x = 0; x < px; x++) {
      // 這一欄涵蓋的包絡取最大值，縮小時才不會漏掉短的聲音
      const a = Math.floor(from + (x / px) * span);
      const b = Math.max(a + 1, Math.floor(from + ((x + 1) / px) * span));
      let peak = 0;
      for (let i = a; i < b && i < envelope.rms.length; i++) peak = Math.max(peak, envelope.rms[i]);
      const bar = Math.min(1, peak * 3) * h;
      ctx.fillRect(x, (h - bar) / 2, 1, Math.max(1, bar));
    }
  }, [envelope, clip.srcIn, clip.srcOut, px]);
  return <canvas ref={ref} className="waveform" width={px} height={32} />;
}

/** 影格條最多幾格（再長的片段就把每格拉寬，避免一小時的片段塞上千張圖） */
const FILM_MAX_TILES = 300;
/** 影格條每格的寬度（片段高度 × 16:9） */
const FILM_TILE_PX = 60;

/**
 * 影片片段的影格條（D39）：依片段寬度切格，每格取格子中間那個時間最近的縮圖（做好的最細一層）；
 * 縮圖還沒做好的格子留空，做好了（ThumbStore 通知）就補上。
 */
function Filmstrip({ thumbs, clip, width, pxPerSecond }: { thumbs: ThumbStore; clip: Clip; width: number; pxPerSecond: number }) {
  useSyncExternalStore((fn) => thumbs.subscribe(fn), () => thumbs.version);
  const tiles = Math.max(1, Math.min(FILM_MAX_TILES, Math.ceil(width / FILM_TILE_PX)));
  const tileW = width / tiles;
  /** 用到最細的一層（data-thumb-tier 給測試看） */
  let finest = -1;
  const cells = Array.from({ length: tiles }, (_, i) => {
    const src = timelineToSource(clip, clip.start + ((i + 0.5) * tileW) / pxPerSecond) ?? clip.srcIn;
    const ref = thumbs.pick(clip.mediaId, src);
    const url = ref ? thumbs.url(clip.mediaId, ref) : null;
    if (ref && url) finest = Math.max(finest, ref.tier);
    return url ? <img key={i} src={url} alt="" draggable={false} style={{ left: i * tileW, width: tileW }} /> : null;
  });
  return <div className="filmstrip" data-thumb-tier={finest}>{cells}</div>;
}

/** 軌道標頭的預設寬度（可拖分隔線調整，見 layout.ts） */
export const HEADER_WIDTH = 88;

/** 時間軸的軌道列：由上到下 V（高的在上）、S1 字幕、A */
interface Row {
  id: string;
  label: string;
  kind: "video" | "audio" | "subtitle";
  track?: Track;
}

/** 依 §5.13 排出軌道列：疊加軌在上、V1、字幕軌、音軌 */
function rows(project: Project): Row[] {
  const video = project.tracks.filter((t) => t.kind === "video").sort((a, b) => b.index - a.index);
  const audio = project.tracks.filter((t) => t.kind === "audio").sort((a, b) => a.index - b.index);
  return [
    ...video.map((t) => ({ id: t.id, label: `V${t.index + 1}`, kind: "video" as const, track: t })),
    { id: "S1", label: "S1", kind: "subtitle" as const },
    ...audio.map((t) => ({ id: t.id, label: `A${t.index + 1}`, kind: "audio" as const, track: t })),
  ];
}

/** 尺規刻度的間隔：讓刻度之間至少 80 像素 */
function rulerStep(pxPerSecond: number): number {
  return [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((s) => s * pxPerSecond >= 80) ?? 600;
}

/** 下方多軌時間軸（D33）：工具列、尺規、各軌片段、特效標籤、字幕軌、播放頭 */
export function Timeline({ state, dispatch, captions, library, onRangeAction, zoomEdit = null, onZoomEdit, headerWidth = HEADER_WIDTH, headerSplitter, thumbs }: {
  state: AppState;
  /** 縮圖序列（影片片段的影格條） */
  thumbs?: ThumbStore;
  /** 軌道標頭寬度（像素） */
  headerWidth?: number;
  /** 軌道標頭右邊的分隔線（由 App 給，拖曳調整寬度） */
  headerSplitter?: ReactNode;
  dispatch: Dispatch<Action>;
  captions: Caption[];
  library: Library;
  /** 範圍動作列的「放大」「特效」（照字導字演：先框選時間，再從範圍建立） */
  onRangeAction?: (kind: "zoom" | "effect" | "mask") => void;
  /** 局部放大：正在調的那一段（放大條標亮）與切換 */
  zoomEdit?: ZoomEdit | null;
  onZoomEdit?: (edit: ZoomEdit | null) => void;
}) {
  const project = state.history.present;
  const { pxPerSecond, playhead } = state;
  const duration = projectDuration(project);
  const width = Math.max(duration + 30, 60) * pxPerSecond;
  const trackRows = useMemo(() => rows(project), [project]);
  const step = rulerStep(pxPerSecond);
  const ticks = Array.from({ length: Math.floor(width / pxPerSecond / step) + 1 }, (_, i) => i * step);

  /**
   * Shift＋按住軌道拖曳：以播放頭為錨點拉出範圍（照字導字演）；按下的位置立刻成為另一端，繼續拖就延伸。
   * 在 capture 階段處理並停止傳遞，才不會變成拖片段或特效。
   */
  const onCanvasDownCapture = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !e.shiftKey || (e.target as HTMLElement).closest(".range-actions")) return;
    e.preventDefault();
    e.stopPropagation();
    const canvas = e.currentTarget;
    const anchor = playhead;
    const at = (clientX: number) => Math.max(0, (clientX - canvas.getBoundingClientRect().left) / pxPerSecond);
    dispatch({ type: "setRange", start: anchor, end: at(e.clientX) });
    const move = (ev: MouseEvent) => dispatch({ type: "setRange", start: anchor, end: at(ev.clientX) });
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** 點尺規或空白處：移動播放頭 */
  const seekAt = (clientX: number, el: HTMLElement) => {
    const x = clientX - el.getBoundingClientRect().left;
    dispatch({ type: "seek", time: x / pxPerSecond });
  };

  /** 在尺規或播放頭上按住拖曳（scrub）：按下的元素，用來換算滑鼠位置；null 表示沒在拖 */
  const [scrubEl, setScrubEl] = useState<HTMLElement | null>(null);
  /** 時間軸畫布（播放頭把手按下時用它換算位置；和尺規同一個左緣） */
  const canvasRef = useRef<HTMLDivElement>(null);

  // 拖曳播放頭：滑鼠移到哪，播放頭就到哪（預覽畫面跟著更新）；放開結束。
  // 滑鼠移動很密時合併到下一個畫格才送一次 seek，避免整個畫面每次移動都重算
  useEffect(() => {
    if (!scrubEl) return;
    let pending: number | null = null;
    let frame = 0;
    const onMove = (e: MouseEvent) => {
      pending = e.clientX;
      if (!frame) frame = requestAnimationFrame(() => { frame = 0; if (pending !== null) seekAt(pending, scrubEl); });
    };
    const onUp = (e: MouseEvent) => {
      cancelAnimationFrame(frame);
      seekAt(e.clientX, scrubEl);
      setScrubEl(null);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    // seekAt 每次 render 都是新的函式，但只依賴 pxPerSecond 與 dispatch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrubEl, pxPerSecond, dispatch]);

  /**
   * 按下尺規（含播放頭把手）或軌道空白處：移到按下的位置並開始拖曳；seek 本身會停止播放或倒退。
   * 片段、特效上不算（它們自己的按下是選取與拖曳）。
   */
  const onScrubDown = (e: ReactMouseEvent<HTMLElement>) => {
    if (e.button !== 0 || e.shiftKey || !canvasRef.current) return;
    // 不 preventDefault：要讓焦點離開輸入框（例如 Inspector 的倍數），之後的 Space 等熱鍵才會作用；拖曳選到字由 CSS user-select 擋
    e.stopPropagation();
    seekAt(e.clientX, canvasRef.current);
    setScrubEl(canvasRef.current);
  };

  /** 拖曳中的片段（沒有拖曳時是 null） */
  const [drag, setDrag] = useState<DragState | null>(null);

  // 拖曳時在 window 上追蹤滑鼠；放開時依移動距離送出移動或修邊的編輯
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => setDrag((d) => (d ? { ...d, x: e.clientX } : d));
    const onUp = (e: MouseEvent) => {
      const final = { ...drag, x: e.clientX };
      const clip = project.clips.find((c) => c.id === final.clipId);
      setDrag(null);
      if (!clip || Math.abs(final.x - final.startX) < DRAG_MIN_PX) return;
      const t = dragTarget(final, clip, state);
      dispatch({
        type: "commit",
        edits: [final.mode === "move" ? { kind: "move", clipId: clip.id, start: t } : { kind: "trim", clipId: clip.id, edge: final.mode, t }],
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, project, state, dispatch]);

  /** 拖曳中的特效標籤 */
  const [fxDrag, setFxDrag] = useState<EffectDrag | null>(null);

  // 特效標籤拖曳：放開時送出移動或修邊
  useEffect(() => {
    if (!fxDrag) return;
    const onMove = (e: MouseEvent) => setFxDrag((d) => (d ? { ...d, x: e.clientX } : d));
    const onUp = (e: MouseEvent) => {
      const final = { ...fxDrag, x: e.clientX };
      const effect = project.effects.find((x) => x.id === final.effectId);
      setFxDrag(null);
      if (!effect || Math.abs(final.x - final.startX) < DRAG_MIN_PX) return;
      const t = effectDragTarget(final, effect, state);
      dispatch({
        type: "commit",
        edits: [final.mode === "move" ? { kind: "moveEffect", effectId: effect.id, start: t } : { kind: "trimEffect", effectId: effect.id, edge: final.mode, t }],
      });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [fxDrag, project, state, dispatch]);

  /** 按下特效標籤：選取，依按的位置決定移動或修邊 */
  const onEffectDown = (e: ReactMouseEvent<HTMLDivElement>, effect: Effect) => {
    e.stopPropagation();
    dispatch({ type: "selectEffect", effectId: effect.id });
    const rect = e.currentTarget.getBoundingClientRect();
    const offset = e.clientX - rect.left;
    const mode = offset < EDGE_GRAB ? "in" : offset > rect.width - EDGE_GRAB ? "out" : "move";
    setFxDrag({ effectId: effect.id, mode, startX: e.clientX, x: e.clientX });
  };

  /** 特效標籤畫在哪裡：拖曳中的畫成拖到的位置 */
  const effectBox = (effect: Effect) => {
    let start = effect.start;
    let end = effect.end;
    if (fxDrag && fxDrag.effectId === effect.id && Math.abs(fxDrag.x - fxDrag.startX) >= DRAG_MIN_PX) {
      const t = effectDragTarget(fxDrag, effect, state);
      if (fxDrag.mode === "move") { end = t + (end - start); start = t; }
      else if (fxDrag.mode === "in") start = Math.min(t, end - 0.1);
      else end = Math.max(t, start + 0.1);
    }
    return { left: start * pxPerSecond, width: Math.max(6, (end - start) * pxPerSecond) };
  };

  /** 按下片段：選取，並依按的位置決定是移動還是修邊 */
  const onClipDown = (e: ReactMouseEvent<HTMLDivElement>, clip: Clip) => {
    e.stopPropagation();
    dispatch({ type: "select", clipId: clip.id });
    const rect = e.currentTarget.getBoundingClientRect();
    const offset = e.clientX - rect.left;
    const mode = offset < EDGE_GRAB ? "in" : offset > rect.width - EDGE_GRAB ? "out" : "move";
    setDrag({ clipId: clip.id, mode, startX: e.clientX, x: e.clientX });
  };

  /** 片段畫在哪裡：拖曳中的片段畫成拖到的位置（虛影），其他照實際位置 */
  const clipBox = (clip: Clip) => {
    let start = clip.start;
    let end = clipEnd(clip);
    if (drag && drag.clipId === clip.id && Math.abs(drag.x - drag.startX) >= DRAG_MIN_PX) {
      const t = dragTarget(drag, clip, state);
      if (drag.mode === "move") { end = t + (end - start); start = t; }
      else if (drag.mode === "in") start = Math.min(t, end - 0.01);
      else end = Math.max(t, start + 0.01);
    }
    return { left: start * pxPerSecond, width: (end - start) * pxPerSecond };
  };

  /** 片段上顯示的名稱：素材檔名，沒有就用 id */
  const mediaName = (mediaId: string) => project.media.find((m) => m.id === mediaId)?.name ?? mediaId;

  /** Ctrl＋滾輪縮放時間軸 */
  const onWheel = (e: WheelEvent) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    dispatch({ type: "zoom", pxPerSecond: pxPerSecond * (e.deltaY < 0 ? 1.25 : 0.8) });
  };

  return (
    <section className="timeline">
      <div className="timeline-toolbar">
        <span className="timecode big">{formatTimecode(playhead)}</span>
        <span className="muted">/ {formatTimecode(duration)}</span>
        <button title="Undo (Ctrl+Z)" disabled={!state.history.past.length} onClick={() => dispatch({ type: "undo" })}>↶</button>
        <button title="Redo (Ctrl+Shift+Z)" disabled={!state.history.future.length} onClick={() => dispatch({ type: "redo" })}>↷</button>
        <button title="Delete selected (Delete)" disabled={!state.selectedClipId} onClick={() => dispatch({ type: "deleteSelected" })}>✂ Delete</button>
        <span className="spacer" />
        <button title="Zoom out" onClick={() => dispatch({ type: "zoom", pxPerSecond: pxPerSecond * 0.8 })}>−</button>
        <button title="Zoom in" onClick={() => dispatch({ type: "zoom", pxPerSecond: pxPerSecond * 1.25 })}>+</button>
      </div>
      <div className="timeline-body" onWheel={onWheel}>
        <div className="track-headers" style={{ width: headerWidth }}>
          <div className="ruler-spacer" />
          {trackRows.map((r) => (
            <div key={r.id} className={`track-header ${r.kind}`}>
              <span className="track-badge">{r.label}</span>
              {r.track?.locked && <span title="Locked">🔒</span>}
            </div>
          ))}
        </div>
        {headerSplitter}
        <div className="track-scroll">
          <div className="track-canvas" ref={canvasRef} style={{ width }} onMouseDownCapture={onCanvasDownCapture}>
            <div className={`ruler${scrubEl ? " scrubbing" : ""}`} onMouseDown={onScrubDown} title="Drag to scrub">
              {ticks.map((t) => (
                <span key={t} className="tick" style={{ left: t * pxPerSecond }}>{formatTimecode(t).slice(3, 8)}</span>
              ))}
              {/* 播放頭把手與拖曳時的時間碼放在尺規裡：按把手就是按尺規（拖曳） */}
              <div className="playhead-handle" data-testid="playhead-handle" style={{ left: playhead * pxPerSecond }} />
              {scrubEl && <div className="scrub-time" data-testid="scrub-time" style={{ left: playhead * pxPerSecond }}>{formatTimecode(playhead).slice(3)}</div>}
            </div>
            {trackRows.map((r) => (
              <div key={r.id} className={`track-row ${r.kind}`} data-track-id={r.track?.id} onMouseDown={(e) => { if (e.target === e.currentTarget) { dispatch({ type: "select", clipId: null }); onScrubDown(e); } }}>
                {r.kind === "subtitle"
                  ? captions.map((c) => (
                      <div key={c.id} className="caption-block" style={{ left: c.start * pxPerSecond, width: (c.end - c.start) * pxPerSecond }} title={c.lines.join(" ")}>
                        {c.lines.join(" ")}
                      </div>
                    ))
                  : project.clips.filter((c) => c.trackId === r.id).map((c) => (
                      <div
                        key={c.id}
                        className={`clip ${r.kind}${state.selectedClipId === c.id ? " selected" : ""}${drag?.clipId === c.id ? " dragging" : ""}`}
                        style={clipBox(c)}
                        onMouseDown={(e) => onClipDown(e, c)}
                        title={`${mediaName(c.mediaId)}  ${formatTimecode(c.start)} – ${formatTimecode(clipEnd(c))}`}
                      >
                        {r.kind === "audio" && library.envelopes.has(c.mediaId) && <Waveform envelope={library.envelopes.get(c.mediaId)!} clip={c} width={clipBox(c).width} />}
                        {r.kind === "video" && thumbs && <Filmstrip thumbs={thumbs} clip={c} width={clipBox(c).width} pxPerSecond={pxPerSecond} />}
                        <span className="edge in" />
                        <span className="clip-label">{mediaName(c.mediaId)}</span>
                        <span className="edge out" />
                      </div>
                    ))}
                {r.id === trackRows.find((x) => x.kind === "video" && x.track?.index === 0)?.id && (
                  <ZoomBands project={project} pxPerSecond={pxPerSecond} edit={zoomEdit} onEdit={(e) => onZoomEdit?.(e)} dispatch={dispatch} />
                )}
                {r.id === trackRows.find((x) => x.kind === "video" && x.track?.index === 0)?.id &&
                  project.effects.map((fx) => (
                    <div
                      key={fx.id}
                      className={`effect-chip${state.selectedEffectId === fx.id ? " selected" : ""}${fxDrag?.effectId === fx.id ? " dragging" : ""}`}
                      data-effect-id={fx.id}
                      style={effectBox(fx)}
                      onMouseDown={(e) => onEffectDown(e, fx)}
                      title={`${String(fx.params.title ?? fx.kind)}  ${formatTimecode(fx.start)} – ${formatTimecode(fx.end)}`}
                    >
                      ✨ {String(fx.params.title ?? fx.kind)}
                    </div>
                  ))}
              </div>
            ))}
            {state.range && (
              <>
                <div className="range-overlay" data-testid="range-overlay" style={{ left: state.range.start * pxPerSecond, width: (state.range.end - state.range.start) * pxPerSecond }} />
                {/* 範圍上方的動作列：先框選時間再建立（照字導字演） */}
                <div className="range-actions" data-testid="range-actions" style={{ left: state.range.start * pxPerSecond }} onMouseDown={(e) => e.stopPropagation()}>
                  <button type="button" data-testid="range-zoom" title="Zoom into part of the frame for this range" onClick={() => onRangeAction?.("zoom")}>🔍 Zoom</button>
                  <button type="button" data-testid="range-effect" title="Add an effect for this range" onClick={() => onRangeAction?.("effect")}>✨ Effect</button>
                  <button type="button" data-testid="range-mask" title="Hide faces, plates or text in this range" onClick={() => onRangeAction?.("mask")}>🛡 Mask</button>
                  <button type="button" data-testid="range-delete" title="Cut this range (Delete)" onClick={() => dispatch({ type: "deleteRange" })}>✂ Delete</button>
                  <button type="button" data-testid="range-cancel" title="Clear the range (Esc)" onClick={() => dispatch({ type: "clearRange" })}>✕</button>
                  <span className="muted">{formatTimecode(state.range.end - state.range.start).slice(3)}</span>
                </div>
              </>
            )}
            <div className="playhead" style={{ left: playhead * pxPerSecond }} />
          </div>
        </div>
      </div>
    </section>
  );
}
