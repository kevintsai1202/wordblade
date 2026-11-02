// 特效 → Color 子頁籤（P3 色彩調整；2026-11-02）：亮度、對比、飽和度、色溫。
// 預設套整條（到結尾，之後加的片段也套）；時間軸有選範圍時新增的只調那段。重疊時後加的蓋前面的。
// 滑桿拖動時只改畫面上的數字，放開才送一筆可復原的編輯（不會拖一次留幾十筆歷史）。
import { useEffect, useState, type Dispatch } from "react";
import { NEUTRAL, type GradeValues } from "../core/colorGrade";
import type { ColorGrade, Project } from "../core/model";
import { formatTimecode, type Action } from "./state";

/** 四個滑桿 */
const FIELDS: { key: keyof GradeValues; label: string }[] = [
  { key: "brightness", label: "Brightness" },
  { key: "contrast", label: "Contrast" },
  { key: "saturation", label: "Saturation" },
  { key: "temperature", label: "Temperature" },
];

/** 範圍的顯示文字 */
function rangeLabel(g: ColorGrade): string {
  return g.end === undefined ? (g.start > 0 ? `${formatTimecode(g.start).slice(3)} – end` : "Whole video") : `${formatTimecode(g.start).slice(3)} – ${formatTimecode(g.end).slice(3)}`;
}

/** Color 子頁籤 */
export function ColorTab({ project, range, dispatch }: {
  project: Project;
  /** 時間軸選的範圍：有的話新增的調整只套這段 */
  range?: { start: number; end: number } | null;
  dispatch: Dispatch<Action>;
}) {
  const grades = project.colorGrades ?? [];
  /** 正在編輯的那一段（預設最後一段） */
  const [selected, setSelected] = useState<string | null>(null);
  const current = grades.find((g) => g.id === selected) ?? grades[grades.length - 1] ?? null;
  /** 滑桿拖動中的值（放開才寫進專案） */
  const [draft, setDraft] = useState<GradeValues>(current ?? NEUTRAL);
  useEffect(() => { setDraft(current ?? NEUTRAL); }, [current?.id, current?.brightness, current?.contrast, current?.saturation, current?.temperature]); // eslint-disable-line react-hooks/exhaustive-deps

  /** 寫進專案：有正在編輯的就改它，否則新增一段（依範圍） */
  const save = (values: GradeValues) => {
    if (current) dispatch({ type: "commit", edits: [{ kind: "setColorGrade", id: current.id, values }] });
    else add(values);
  };
  /** 新增一段：有選範圍只調那段，否則整條 */
  const add = (values: GradeValues = NEUTRAL) => {
    const id = `cg-${crypto.randomUUID().slice(0, 8)}`;
    dispatch({ type: "commit", edits: [{ kind: "setColorGrade", id, values, range: range ?? null }] });
    setSelected(id);
  };

  return (
    <div className="vibe-tab" data-testid="color-tab">
      <h3 className="section-title">Color</h3>
      <p className="muted" data-testid="color-target">
        {current ? `Adjusting: ${rangeLabel(current)}` : range ? "Adjusts the selected range." : "Adjusts the whole video. Select a range on the timeline to adjust just that part."}
      </p>
      {FIELDS.map((f) => (
        <label key={f.key} className="param-field">
          <span>{f.label}</span>
          <input
            type="range" min={-1} max={1} step={0.05} data-testid={`color-${f.key}`} value={draft[f.key]}
            onChange={(e) => setDraft({ ...draft, [f.key]: Number(e.target.value) })}
            onPointerUp={() => save(draft)} onKeyUp={() => save(draft)}
          />
          <span className="muted">{draft[f.key].toFixed(2)}</span>
        </label>
      ))}
      <div className="vibe-actions">
        <button type="button" data-testid="color-reset" disabled={!current} onClick={() => save(NEUTRAL)}>Reset</button>
        <span className="spacer" />
        <button type="button" data-testid="color-add" onClick={() => add()}>{range ? "New for selected range" : "New for whole video"}</button>
      </div>
      {grades.length > 0 && (
        <ul className="transcribe-list" data-testid="color-list">
          {grades.map((g) => (
            <li key={g.id} data-testid="color-item" className={g.id === current?.id ? "active" : ""}>
              <button type="button" className="media-name" onClick={() => setSelected(g.id)}>{rangeLabel(g)}</button>
              <button type="button" data-testid="color-delete" onClick={() => dispatch({ type: "commit", edits: [{ kind: "deleteColorGrade", id: g.id }] })}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
