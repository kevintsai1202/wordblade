import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * 區塊之間的分隔線（開發者 2026-10-28：每個區塊都可以調大小）。
 * axis：x 左右拖（改寬度）、y 上下拖（改高度）；sign：滑鼠往右／往下時尺寸變大是 1，變小是 -1（例如右側面板往左拖才變寬）。
 * 用 pointer capture：滑鼠拖出視窗外放開也收得到。雙擊回預設。
 */
export function Splitter({ axis, value, sign, onChange, onReset, testId, title }: {
  axis: "x" | "y";
  /** 目前的尺寸（像素） */
  value: number;
  sign: 1 | -1;
  onChange: (value: number) => void;
  onReset: () => void;
  testId: string;
  title: string;
}) {
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    /** 按下時的滑鼠位置與尺寸 */
    const start = axis === "x" ? e.clientX : e.clientY;
    const startValue = value;
    const move = (ev: PointerEvent) => onChange(startValue + ((axis === "x" ? ev.clientX : ev.clientY) - start) * sign);
    const up = () => {
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
    };
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
  };
  return <div className={`splitter ${axis}`} data-testid={testId} title={`${title} (double-click to reset)`} onPointerDown={onPointerDown} onDoubleClick={onReset} />;
}
