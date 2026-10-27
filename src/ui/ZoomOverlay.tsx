// 局部放大的選範圍（spec §5.19）：按下 Zoom 頁籤的「Pick region」後，在預覽上從按下的點拉出一個框（比例鎖成畫面比例），
// 放開時回報框的中心與倍率（倍率＝1／框的相對大小，夾在 1～4；中心夾在框不會超出畫面的範圍）。框太小（不到 2%）當作沒拖。
import { useState, type MouseEvent as ReactMouseEvent } from "react";
import type { Zoom } from "../core/zoom";

/** 拖曳中：起點與目前的位置（0～1） */
interface Drag {
  ax: number;
  ay: number;
  x: number;
  y: number;
}

/** 拉框的結果：框的左上角與大小（0～1） */
function boxOf(d: Drag): { x: number; y: number; s: number } {
  const s = Math.min(1, Math.max(Math.abs(d.x - d.ax), Math.abs(d.y - d.ay)));
  return { x: d.x < d.ax ? d.ax - s : d.ax, y: d.y < d.ay ? d.ay - s : d.ay, s };
}

/** 預覽上的拉框層 */
export function ZoomOverlay({ onPick, onCancel }: { onPick: (zoom: Zoom) => void; onCancel: () => void }) {
  const [drag, setDrag] = useState<Drag | null>(null);
  /** 滑鼠位置換成畫面比例 */
  const at = (e: ReactMouseEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), y: Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) };
  };
  const box = drag ? boxOf(drag) : null;
  return (
    <div
      className="zoom-overlay" data-testid="zoom-overlay"
      onMouseDown={(e) => { const p = at(e); setDrag({ ax: p.x, ay: p.y, ...p }); }}
      onMouseMove={(e) => { if (drag) setDrag({ ...drag, ...at(e) }); }}
      onMouseUp={() => {
        if (!drag || !box) return;
        setDrag(null);
        if (box.s < 0.02) return;
        const scale = Math.min(4, Math.max(1, 1 / box.s));
        const w = 1 / scale;
        const clamp = (c: number) => Math.min(1 - w / 2, Math.max(w / 2, c));
        onPick({ scale, cx: clamp(box.x + box.s / 2), cy: clamp(box.y + box.s / 2) });
      }}
      onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}
      tabIndex={0}
      autoFocus
    >
      {box && <div className="zoom-box" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.s * 100}%`, height: `${box.s * 100}%` }} />}
      {!drag && <div className="zoom-hint">Drag a box over the area to zoom into</div>}
    </div>
  );
}
