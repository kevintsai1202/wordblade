// 預覽上的放大框（spec §5.19、D38，照字導字演 zoom.js 的調框）：調框時預覽顯示沒放大的畫面，框＝放大後看得到的範圍。
// 拖框：沒選路徑點時整段平移（所有點移同樣距離、先夾好不出界，路徑形狀不變）；選了點（點時間軸上的菱形）就只改那一點。
// 拖右下角：等比改框的大小（中心不動）。「＋Keyframe」在播放頭加一個路徑點（用目前看到的中心）。放開才寫回（一筆可復原的編輯）。
import { useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Clip, ZoomRegion } from "../core/model";
import { timelineToSource } from "../core/timeline";
import { centerAt, clampCenter, MIN_W } from "../core/zoom";
import type { ZoomEdit } from "./ZoomBands";

/** 拖曳中 */
interface BoxDrag {
  mode: "move" | "resize";
  x: number;
  y: number;
  original: ZoomRegion;
}

/** 預覽上的放大框 */
export function ZoomEditOverlay({ zoom, clip, playhead, edit, onCommit, onAddPoint, onDone, onDelete }: {
  zoom: ZoomRegion;
  /** 播放頭所在、用到這支素材的 V1 片段（換算素材時間用；不在任何片段上為 null） */
  clip: Clip | null;
  playhead: number;
  edit: ZoomEdit;
  onCommit: (zoom: ZoomRegion) => void;
  onAddPoint: (src: number, cx: number, cy: number) => void;
  onDone: () => void;
  onDelete: () => void;
}) {
  const [live, setLive] = useState<ZoomRegion | null>(null);
  const [drag, setDrag] = useState<BoxDrag | null>(null);
  const current = live ?? zoom;
  const src = clip ? timelineToSource(clip, playhead) : null;
  const inside = src !== null && src >= zoom.start - 1e-6 && src <= zoom.end + 1e-6;
  const c = inside ? centerAt(current.path, src!) : null;
  const w = current.w;

  /** 拖曳：位移換成畫面比例，算出新的區段（只存在本地，放開才寫回） */
  const onMove = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (!drag) return;
    const r = e.currentTarget.getBoundingClientRect();
    const dx = (e.clientX - drag.x) / r.width;
    const dy = (e.clientY - drag.y) / r.height;
    const o = drag.original;
    if (drag.mode === "resize") {
      const nw = Math.min(1, Math.max(MIN_W, o.w + 2 * Math.max(dx, dy)));
      setLive({ ...o, w: nw, path: o.path.map((p) => ({ ...p, cx: clampCenter(p.cx, nw), cy: clampCenter(p.cy, nw) })) });
      return;
    }
    if (edit.point !== null && o.path[edit.point]) {
      // 選了路徑點：只改那一點
      setLive({ ...o, path: o.path.map((p, i) => (i === edit.point ? { ...p, cx: clampCenter(p.cx + dx, o.w), cy: clampCenter(p.cy + dy, o.w) } : p)) });
      return;
    }
    // 整段平移：位移先夾到每一點都不出界
    const lo = (k: "cx" | "cy") => Math.max(...o.path.map((p) => o.w / 2 - p[k]));
    const hi = (k: "cx" | "cy") => Math.min(...o.path.map((p) => 1 - o.w / 2 - p[k]));
    const mx = Math.min(hi("cx"), Math.max(lo("cx"), dx));
    const my = Math.min(hi("cy"), Math.max(lo("cy"), dy));
    setLive({ ...o, path: o.path.map((p) => ({ ...p, cx: p.cx + mx, cy: p.cy + my })) });
  };

  /** 放開：寫回 */
  const onUp = () => {
    if (live) onCommit(live);
    setLive(null);
    setDrag(null);
  };

  return (
    <div className="zoom-edit" data-testid="zoom-edit" tabIndex={0} autoFocus onMouseMove={onMove} onMouseUp={onUp} onMouseLeave={onUp}
      onKeyDown={(e) => { if (e.key === "Escape" || e.key === "Enter") { e.preventDefault(); onDone(); } }}>
      {c ? (
        <div className="zoom-frame" data-testid="zoom-frame" style={{ left: `${(c.cx - w / 2) * 100}%`, top: `${(c.cy - w / 2) * 100}%`, width: `${w * 100}%`, height: `${w * 100}%` }}
          onMouseDown={(e) => { e.preventDefault(); setDrag({ mode: "move", x: e.clientX, y: e.clientY, original: current }); }}>
          <span className="zoom-scale">×{(1 / w).toFixed(1)}{edit.point !== null ? " · point" : ""}</span>
          <span className="zoom-resize" data-testid="zoom-resize" onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); setDrag({ mode: "resize", x: e.clientX, y: e.clientY, original: current }); }} />
        </div>
      ) : (
        <div className="zoom-outside">Move the playhead into the zoom range to adjust the box.</div>
      )}
      <div className="zoom-toolbar" onMouseDown={(e) => e.stopPropagation()}>
        <button type="button" data-testid="zoom-add-point" disabled={!c} onClick={() => c && onAddPoint(src!, c.cx, c.cy)}>＋ Keyframe</button>
        <button type="button" data-testid="zoom-delete" onClick={onDelete}>🗑 Delete zoom</button>
        <button type="button" data-testid="zoom-done" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}
