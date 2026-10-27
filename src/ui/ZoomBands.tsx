// 時間軸 V1 上的放大條（spec §5.19、D38，照字導字演 timeline.js 的 .zoomband）：
// 每段放大在用到那支素材的每個 V1 片段上各畫一條（剪輯後一段放大可能變成兩條）。拖條本身移動整段（路徑點跟著走）、
// 拖兩端修邊、菱形是路徑點（點一下選取並跳到那裡、Delete 刪掉那一點）；條本身 Delete 刪掉整段。
// 拖曳夾在那個片段的素材範圍內（不跨片段）；放開才寫回（一筆可復原的編輯）。
import { useState, type Dispatch, type KeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactElement } from "react";
import type { Clip, Project, ZoomRegion } from "../core/model";
import { clipEnd, sourceToTimeline } from "../core/timeline";
import { moveZoom, trimZoom } from "../core/zoom";
import type { Action } from "./state";

/** 正在調的放大與選取的路徑點 */
export interface ZoomEdit {
  zoomId: string;
  point: number | null;
}

/** 拖曳中 */
interface BandDrag {
  zoomId: string;
  clipId: string;
  mode: "move" | "start" | "end";
  startX: number;
  original: ZoomRegion;
  live: ZoomRegion;
  moved: boolean;
}

/** 放大條 */
export function ZoomBands({ project, pxPerSecond, edit, onEdit, dispatch }: {
  project: Project;
  pxPerSecond: number;
  edit: ZoomEdit | null;
  onEdit: (edit: ZoomEdit | null) => void;
  dispatch: Dispatch<Action>;
}) {
  const [drag, setDrag] = useState<BandDrag | null>(null);
  const v1 = project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;

  /** 開始拖：移動整段或修邊；沒拖動就當成點選（進入調框） */
  const onDown = (e: ReactMouseEvent<HTMLElement>, zoom: ZoomRegion, clip: Clip, mode: BandDrag["mode"]) => {
    if (e.button !== 0 || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    // preventDefault 擋掉了自動聚焦，手動聚焦 Delete 才收得到（原專案的坑）
    (e.currentTarget.closest(".zoomband") as HTMLElement | null)?.focus();
    let state: BandDrag = { zoomId: zoom.id, clipId: clip.id, mode, startX: e.clientX, original: zoom, live: zoom, moved: false };
    setDrag(state);
    const move = (ev: MouseEvent) => {
      const dx = ev.clientX - state.startX;
      if (Math.abs(dx) < 3 && !state.moved) return;
      const ds = (dx / pxPerSecond) * clip.speed;
      const live = mode === "move" ? moveZoom(state.original, ds, clip.srcIn, clip.srcOut)
        : trimZoom(state.original, mode, (mode === "start" ? state.original.start : state.original.end) + ds, clip.srcIn, clip.srcOut);
      state = { ...state, live, moved: true };
      setDrag(state);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      if (state.moved) dispatch({ type: "commit", edits: [{ kind: "setZoom", zoom: state.live }] });
      else onEdit({ zoomId: zoom.id, point: null });
      setDrag(null);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  /** 條上按 Delete：刪掉整段（停止冒泡，不然全域的 Delete 會把選取的片段也刪掉） */
  const onBandKey = (e: KeyboardEvent<HTMLElement>, zoom: ZoomRegion) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    e.stopPropagation();
    dispatch({ type: "commit", edits: [{ kind: "deleteZoom", zoomId: zoom.id }] });
    if (edit?.zoomId === zoom.id) onEdit(null);
  };

  /** 菱形按 Delete：刪掉那一點（至少留一點） */
  const onPointKey = (e: KeyboardEvent<HTMLElement>, zoom: ZoomRegion, index: number) => {
    if (e.key !== "Delete" && e.key !== "Backspace") return;
    e.preventDefault();
    e.stopPropagation();
    if (zoom.path.length <= 1) return;
    dispatch({ type: "commit", edits: [{ kind: "setZoom", zoom: { ...zoom, path: zoom.path.filter((_, i) => i !== index) } }] });
    onEdit({ zoomId: zoom.id, point: null });
  };

  const bands: ReactElement[] = [];
  for (const original of project.zooms ?? []) {
    const zoom = drag?.zoomId === original.id ? drag.live : original;
    for (const clip of project.clips) {
      if (clip.trackId !== v1 || clip.mediaId !== zoom.mediaId || clip.freeze) continue;
      const s0 = Math.max(zoom.start, clip.srcIn);
      const s1 = Math.min(zoom.end, clip.srcOut);
      if (s1 <= s0) continue;
      const left = sourceToTimeline(clip, s0)! * pxPerSecond;
      const right = Math.min(sourceToTimeline(clip, s1)!, clipEnd(clip)) * pxPerSecond;
      const selected = edit?.zoomId === zoom.id;
      bands.push(
        <div
          key={`${zoom.id}@${clip.id}`} className={`zoomband${selected ? " selected" : ""}${zoom.enabled ? "" : " disabled"}`}
          data-zoom-id={zoom.id} tabIndex={0} style={{ left, width: Math.max(4, right - left) }}
          title={`Zoom ×${(1 / zoom.w).toFixed(1)} — drag to move, drag the ends to trim, Delete to remove`}
          onMouseDown={(e) => onDown(e, original, clip, "move")} onKeyDown={(e) => onBandKey(e, original)}
        >
          {right - left > 18 && <span className="zhandle start" onMouseDown={(e) => onDown(e, original, clip, "start")} />}
          {right - left > 18 && <span className="zhandle end" onMouseDown={(e) => onDown(e, original, clip, "end")} />}
          {zoom.path.map((p, i) => {
            if (p.src < s0 - 1e-6 || p.src > s1 + 1e-6) return null;
            const x = sourceToTimeline(clip, Math.max(s0, Math.min(s1, p.src)))! * pxPerSecond - left;
            return (
              <span
                key={i} className={`zoompt${selected && edit?.point === i ? " selected" : ""}`} data-point={i} tabIndex={0}
                style={{ left: Math.max(6, x) }} title="Path point — click to adjust this point, Delete to remove"
                onMouseDown={(e) => {
                  e.stopPropagation();
                  e.preventDefault();
                  e.currentTarget.focus();
                  onEdit({ zoomId: original.id, point: i });
                  dispatch({ type: "seek", time: sourceToTimeline(clip, p.src) ?? clip.start });
                }}
                onKeyDown={(e) => onPointKey(e, original, i)}
              />
            );
          })}
        </div>,
      );
    }
  }
  return <>{bands}</>;
}
