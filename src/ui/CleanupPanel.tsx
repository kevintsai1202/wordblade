// 一鍵去贅詞（spec §5.16）＋清除無聲片段（§5.16b）的確認清單：找出來 → 每條可試聽、可取消勾選 → Remove selected
// 一次剪掉（cutRanges，一筆編輯、一次 Ctrl+Z 復原）。範圍用素材時間記，贅詞和停頓可以一起剪。
import { useEffect, useState, type Dispatch } from "react";
import { ensureAudioGraph } from "../audio/audioGraph";
import type { Envelope } from "../audio/envelope";
import { DEFAULT_SILENCE, findFillers, findSilences, toCutRanges, type CleanupItem } from "../core/cleanup";
import type { Project } from "../core/model";
import { formatTimecode, type Action } from "./state";

/** 清理面板 */
export function CleanupPanel({ project, envelopes, dispatch }: { project: Project; envelopes: Map<string, Envelope>; dispatch: Dispatch<Action> }) {
  const [items, setItems] = useState<CleanupItem[] | null>(null);
  /** 取消勾選的條目 id（預設全勾） */
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  /** 停頓至少幾秒 */
  const [minPause, setMinPause] = useState(DEFAULT_SILENCE.minDuration);

  // 片段變了（剪過、復原）清單的時間軸位置就不準了，收起來重找
  useEffect(() => { setItems(null); }, [project.clips]);

  /** 找贅詞與停頓（兩種合在同一份清單） */
  const find = (kinds: { fillers: boolean; pauses: boolean }) => {
    const list = [...(kinds.fillers ? findFillers(project) : []), ...(kinds.pauses ? findSilences(project, envelopes, { minDuration: minPause }) : [])].sort((a, b) => a.t - b.t);
    setItems(list);
    setUnchecked(new Set());
  };

  /** 試聽：從前 0.3 秒播到後 0.3 秒 */
  const preview = (item: CleanupItem) => {
    ensureAudioGraph();
    dispatch({ type: "seek", time: Math.max(0, item.t - 0.3) });
    dispatch({ type: "play", rate: 1, stopAt: item.t + (item.end - item.start) + 0.3 });
  };

  const chosen = (items ?? []).filter((i) => !unchecked.has(i.id));
  /** 一次剪掉勾選的 */
  const remove = () => {
    if (!chosen.length) return;
    dispatch({ type: "commit", edits: [{ kind: "cutRanges", ranges: toCutRanges(chosen) }] });
    setItems(null);
  };

  const hasWords = project.words.length > 0;
  return (
    <div className="cleanup-panel" data-testid="cleanup-panel">
      <div className="cleanup-actions">
        <button type="button" data-testid="find-fillers" disabled={!hasWords} title={hasWords ? "" : "Transcribe first"} onClick={() => find({ fillers: true, pauses: false })}>Find fillers</button>
        <button type="button" data-testid="find-pauses" onClick={() => find({ fillers: false, pauses: true })}>Find pauses</button>
        <label className="muted">≥ <input type="number" data-testid="min-pause" min={0.3} max={10} step={0.1} value={minPause} onChange={(e) => setMinPause(Number(e.target.value))} /> s</label>
      </div>
      {items && (
        items.length === 0 ? <p className="muted" data-testid="cleanup-empty">Nothing found.</p> : (
          <>
            <ul className="cleanup-list">
              {items.map((item) => (
                <li key={item.id} data-testid="cleanup-item" data-kind={item.kind}>
                  <input type="checkbox" checked={!unchecked.has(item.id)} onChange={(e) => {
                    const next = new Set(unchecked);
                    if (e.target.checked) next.delete(item.id);
                    else next.add(item.id);
                    setUnchecked(next);
                  }} />
                  <span className={`tag ${item.kind}`}>{item.kind === "filler" ? "filler" : "pause"}</span>
                  <span className="label">{item.label}</span>
                  <span className="timecode muted">{formatTimecode(item.t).slice(3)}</span>
                  <button type="button" className="link" title="Preview" onClick={() => preview(item)}>▶</button>
                </li>
              ))}
            </ul>
            <button type="button" data-testid="cleanup-remove" disabled={!chosen.length} onClick={remove}>Remove selected ({chosen.length})</button>
          </>
        )
      )}
    </div>
  );
}
