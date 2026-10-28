// 主畫面區塊大小（開發者 2026-10-28）：預覽｜右側面板、上方｜時間軸、軌道標頭三條分隔線的位置。
// 記在這台電腦（localStorage，換專案也沿用），不進專案檔、不進復原歷史；讀回來時壞掉或超出範圍就自我修正。
import { useCallback, useState } from "react";

/** 三個可調的尺寸（像素） */
export interface Layout {
  /** 右側編輯面板寬度 */
  panelWidth: number;
  /** 下方時間軸高度 */
  timelineHeight: number;
  /** 時間軸軌道標頭寬度 */
  headerWidth: number;
}

/** 預設尺寸（也是雙擊分隔線回復的值） */
export const DEFAULT_LAYOUT: Layout = { panelWidth: 380, timelineHeight: 300, headerWidth: 88 };

/** 各尺寸的範圍（視窗太小時 CSS 另外用 clamp 限制面板與時間軸，不會把預覽擠沒） */
const LIMITS: Record<keyof Layout, [number, number]> = {
  panelWidth: [280, 900],
  timelineHeight: [160, 800],
  headerWidth: [60, 240],
};

/** 存在 localStorage 的鍵 */
const STORAGE_KEY = "wordblade.layout";

/** 夾在範圍內並取整數 */
export function clampLayout(layout: Layout): Layout {
  const out = { ...layout };
  for (const key of Object.keys(LIMITS) as (keyof Layout)[]) {
    const [min, max] = LIMITS[key];
    out[key] = Math.round(Math.min(max, Math.max(min, layout[key])));
  }
  return out;
}

/** 解析存的內容：沒有、壞掉或欄位型別不對的用預設 */
export function parseLayout(raw: string | null): Layout {
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = null;
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { ...DEFAULT_LAYOUT };
  const merged = { ...DEFAULT_LAYOUT };
  for (const key of Object.keys(DEFAULT_LAYOUT) as (keyof Layout)[]) {
    const v = (data as Record<string, unknown>)[key];
    if (typeof v === "number" && Number.isFinite(v)) merged[key] = v;
  }
  return clampLayout(merged);
}

/** 讀這台電腦存的尺寸（讀不到就用預設） */
function loadLayout(): Layout {
  try {
    return parseLayout(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { ...DEFAULT_LAYOUT };
  }
}

/** 版面尺寸：set 改一個尺寸並存起來、reset 把一個尺寸回預設 */
export function useLayout() {
  const [layout, setLayout] = useState<Layout>(loadLayout);
  const set = useCallback((key: keyof Layout, value: number) => {
    setLayout((prev) => {
      const next = clampLayout({ ...prev, [key]: value });
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* 存不了就只在這次有效 */
      }
      return next;
    });
  }, []);
  const reset = useCallback((key: keyof Layout) => set(key, DEFAULT_LAYOUT[key]), [set]);
  return { layout, set, reset };
}
