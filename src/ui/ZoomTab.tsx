// Zoom 頁籤（spec §5.19，照字導字演）：局部放大的清單——每段可開關、調整（進入預覽上的調框）、刪除。
// 建立放大：在時間軸 Shift＋拖曳選範圍，再按動作列的「🔍 Zoom」。
import type { Dispatch } from "react";
import type { Project, ZoomRegion } from "../core/model";
import { sourceToTimeline } from "../core/timeline";
import type { ZoomEdit } from "./ZoomBands";
import { formatTimecode, v1Id, type Action } from "./state";

/** 一段放大第一次出現在時間軸上的位置（沒有在 V1 上回 null） */
export function zoomTimelineStart(project: Project, zoom: ZoomRegion): number | null {
  const v1 = v1Id(project);
  const times = project.clips
    .filter((c) => c.trackId === v1 && c.mediaId === zoom.mediaId && !c.freeze && c.srcOut > zoom.start && c.srcIn < zoom.end)
    .map((c) => sourceToTimeline(c, Math.max(zoom.start, c.srcIn))!)
    .sort((a, b) => a - b);
  return times[0] ?? null;
}

/** Zoom 頁籤 */
export function ZoomTab({ project, edit, onEdit, dispatch }: { project: Project; edit: ZoomEdit | null; onEdit: (edit: ZoomEdit | null) => void; dispatch: Dispatch<Action> }) {
  const zooms = project.zooms ?? [];
  if (!zooms.length) return <p className="muted placeholder" data-testid="zoom-hint">Shift+drag on the timeline to choose a range, then click 🔍 Zoom.</p>;
  return (
    <ul className="zoom-list" data-testid="zoom-list">
      {zooms.map((z) => {
        const t = zoomTimelineStart(project, z);
        return (
          <li key={z.id} data-testid="zoom-row" className={edit?.zoomId === z.id ? "selected" : ""}>
            <input type="checkbox" title="On / off" checked={z.enabled} onChange={(e) => dispatch({ type: "commit", edits: [{ kind: "setZoom", zoom: { ...z, enabled: e.target.checked } }] })} />
            <button type="button" className="link" onClick={() => t !== null && dispatch({ type: "seek", time: t })}>{t === null ? "—" : formatTimecode(t).slice(3)}</button>
            <span>×{(1 / z.w).toFixed(1)}</span>
            <span className="muted">{(z.end - z.start).toFixed(1)} s · {z.path.length} point{z.path.length > 1 ? "s" : ""}</span>
            <span className="spacer" />
            <button type="button" data-testid="zoom-adjust" onClick={() => { if (t !== null) dispatch({ type: "seek", time: t }); onEdit({ zoomId: z.id, point: null }); }}>Adjust</button>
            <button type="button" className="link" title="Delete" onClick={() => { dispatch({ type: "commit", edits: [{ kind: "deleteZoom", zoomId: z.id }] }); if (edit?.zoomId === z.id) onEdit(null); }}>✕</button>
          </li>
        );
      })}
    </ul>
  );
}
