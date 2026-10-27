// 字幕樣式頁籤（spec §5.4、§5.18，D37）：外觀（描邊／底色塊／陰影／不燒進畫面）、逐字高亮（Karaoke）、大小、位置、顏色。
// 每次改動是一筆可復原的編輯（setCaptionStyle）；預覽與匯出畫的是同一份樣式。
import type { Dispatch } from "react";
import { DEFAULT_CAPTION_STYLE, type CaptionStyle } from "../captions/captionLayout";
import type { Project } from "../core/model";
import type { Action } from "./state";

/** 外觀選項 */
const PRESETS: { id: CaptionStyle["preset"]; label: string }[] = [
  { id: "outline", label: "Outline" },
  { id: "box", label: "Box" },
  { id: "shadow", label: "Shadow" },
  { id: "none", label: "Off (SRT only)" },
];

/** 逐字高亮選項 */
const KARAOKE: { id: CaptionStyle["karaoke"]; label: string }[] = [
  { id: "off", label: "Off" },
  { id: "fill", label: "Fill as spoken" },
  { id: "scale", label: "Pop the current word" },
  { id: "box", label: "Box the current word" },
];

/** 字幕樣式頁籤 */
export function CaptionStyleTab({ project, dispatch }: { project: Project; dispatch: Dispatch<Action> }) {
  const style = project.captionStyle ?? DEFAULT_CAPTION_STYLE;
  /** 改幾個欄位（一筆編輯） */
  const set = (patch: Partial<CaptionStyle>) => dispatch({ type: "commit", edits: [{ kind: "setCaptionStyle", style: patch }] });
  return (
    <div className="caption-style-tab" data-testid="caption-style">
      <label className="param-field"><span>Look</span>
        <select data-testid="caption-preset" value={style.preset} onChange={(e) => set({ preset: e.target.value as CaptionStyle["preset"] })}>
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <label className="param-field"><span>Karaoke</span>
        <select data-testid="caption-karaoke" value={style.karaoke} disabled={style.preset === "none"} onChange={(e) => set({ karaoke: e.target.value as CaptionStyle["karaoke"] })}>
          {KARAOKE.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
        </select>
      </label>
      <label className="param-field"><span>Size</span>
        <input type="range" data-testid="caption-size" min={0.03} max={0.1} step={0.005} value={style.size} onChange={(e) => set({ size: Number(e.target.value) })} />
      </label>
      <label className="param-field"><span>Distance from bottom</span>
        <input type="range" min={0.02} max={0.4} step={0.01} value={style.bottom} onChange={(e) => set({ bottom: Number(e.target.value) })} />
      </label>
      <label className="param-field"><span>Text color</span>
        <input type="color" value={style.color} onChange={(e) => set({ color: e.target.value })} />
      </label>
      <label className="param-field"><span>Highlight color</span>
        <input type="color" value={style.highlight} disabled={style.karaoke === "off"} onChange={(e) => set({ highlight: e.target.value })} />
      </label>
      <p className="muted">Captions are drawn into the video (preview and export). An SRT file is always saved next to the export.</p>
    </div>
  );
}
