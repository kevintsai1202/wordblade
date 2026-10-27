// 預覽上的目標框（spec §5.7「使用者框的目標框」）：選到特效時顯示，拖框本身移動、拖右下角改大小；
// 放開時送出一筆可復原的編輯。座標是 0～1 的中心＋寬高，和插件的 env.box 同一套（原專案格式）。
import { useEffect, useState, type Dispatch, type MouseEvent as ReactMouseEvent } from "react";
import type { Effect } from "../core/model";
import type { Action } from "./state";

/** 目標框 */
interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** 拖曳中：移動或改大小、起點的滑鼠位置與框 */
interface Drag {
  mode: "move" | "resize";
  x: number;
  y: number;
  start: Box;
  current: Box;
}

/** 數值夾在範圍內 */
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** 預覽上的目標框 */
export function BoxOverlay({ effect, frame, dispatch }: { effect: Effect; frame: HTMLElement | null; dispatch: Dispatch<Action> }) {
  const box = effect.params.box as Box;
  const [drag, setDrag] = useState<Drag | null>(null);

  // 拖曳：依滑鼠位移（換算成畫面比例）更新框，放開時送出
  useEffect(() => {
    if (!drag || !frame) return;
    const rect = frame.getBoundingClientRect();
    const onMove = (e: MouseEvent) => {
      const dx = (e.clientX - drag.x) / rect.width;
      const dy = (e.clientY - drag.y) / rect.height;
      const s = drag.start;
      const current = drag.mode === "move"
        ? { ...s, cx: clamp(s.cx + dx, 0, 1), cy: clamp(s.cy + dy, 0, 1) }
        : { cx: s.cx + dx / 2, cy: s.cy + dy / 2, w: clamp(s.w + dx, 0.02, 1), h: clamp(s.h + dy, 0.02, 1) };
      setDrag((d) => (d ? { ...d, current } : d));
    };
    const onUp = () => {
      const moved = drag.current !== drag.start;
      setDrag(null);
      if (moved) dispatch({ type: "commit", edits: [{ kind: "setEffectParams", effectId: effect.id, params: { ...effect.params, box: drag.current } }] });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, frame, effect, dispatch]);

  /** 按下框或右下角 */
  const onDown = (e: ReactMouseEvent, mode: Drag["mode"]) => {
    e.preventDefault();
    e.stopPropagation();
    setDrag({ mode, x: e.clientX, y: e.clientY, start: box, current: box });
  };

  const b = drag?.current ?? box;
  return (
    <div
      className="box-overlay"
      data-testid="box-overlay"
      style={{ left: `${(b.cx - b.w / 2) * 100}%`, top: `${(b.cy - b.h / 2) * 100}%`, width: `${b.w * 100}%`, height: `${b.h * 100}%` }}
      onMouseDown={(e) => onDown(e, "move")}
      title="Drag to move the target box"
    >
      <span className="box-handle" data-testid="box-handle" onMouseDown={(e) => onDown(e, "resize")} title="Drag to resize" />
    </div>
  );
}
