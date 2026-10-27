// Zoom 頁籤（spec §5.19 局部放大，P1-2）：選 V1 的片段 →「Pick region」在預覽拉框＝播放頭這個時間點要看的範圍
// （第一次拉會同時建 2 秒後同一個框）；「Zoom out here」在播放頭加 1 倍的關鍵幀；列表改倍率、刪除。每次一筆可復原的編輯。
// 目前只支援 V1 的片段（子母畫面的框要另外換算座標）。
import type { Dispatch } from "react";
import type { Clip, Project, ZoomKey } from "../core/model";
import { sourceToTimeline, timelineToSource } from "../core/timeline";
import { insertZoomKey } from "../core/zoom";
import { formatTimecode, v1Id, type Action } from "./state";

/** 選取的片段（只有 V1 的才能放大） */
export function zoomableClip(project: Project, clipId: string | null): Clip | null {
  const clip = project.clips.find((c) => c.id === clipId);
  return clip && clip.trackId === v1Id(project) && !clip.freeze ? clip : null;
}

/** Zoom 頁籤 */
export function ZoomTab({ project, clipId, playhead, picking, onPicking, dispatch }: {
  project: Project;
  clipId: string | null;
  playhead: number;
  /** 正在預覽上選範圍 */
  picking: boolean;
  onPicking: (on: boolean) => void;
  dispatch: Dispatch<Action>;
}) {
  const clip = zoomableClip(project, clipId);
  if (!clip) return <p className="muted placeholder" data-testid="zoom-hint">Select a clip on V1 to zoom into part of the frame.</p>;
  const keys = clip.zoomKeys ?? [];
  /** 換掉整組關鍵幀（一筆編輯） */
  const commit = (next: ZoomKey[]) => dispatch({ type: "commit", edits: [{ kind: "setZoomKeys", clipId: clip.id, keys: next }] });
  const inside = playhead >= clip.start && playhead < clip.start + (clip.srcOut - clip.srcIn) / clip.speed;
  return (
    <div className="zoom-tab" data-testid="zoom-tab">
      <div className="zoom-actions">
        <button type="button" data-testid="zoom-pick" className={picking ? "active" : ""} disabled={!inside} onClick={() => onPicking(!picking)}>{picking ? "Cancel" : "Pick region"}</button>
        <button type="button" data-testid="zoom-out" disabled={!inside || !keys.length} onClick={() => commit(insertZoomKey(keys, { src: timelineToSource(clip, playhead), scale: 1, cx: 0.5, cy: 0.5 }, clip.srcOut))}>Zoom out here</button>
      </div>
      {!inside && <p className="muted">Move the playhead inside the selected clip.</p>}
      {keys.length === 0 ? <p className="muted">No zoom yet. Pick a region on the preview: it zooms in there and holds for 2 seconds.</p> : (
        <ul className="zoom-keys">
          {keys.map((k, i) => {
            const t = sourceToTimeline(clip, k.src);
            return (
              <li key={i} data-testid="zoom-key">
                <button type="button" className="link" onClick={() => t !== null && dispatch({ type: "seek", time: t })}>{t === null ? "—" : formatTimecode(t).slice(3)}</button>
                <label>×<input type="number" min={1} max={4} step={0.1} value={Math.round(k.scale * 10) / 10}
                  onChange={(e) => commit(keys.map((x, j) => (j === i ? { ...x, scale: Math.min(4, Math.max(1, Number(e.target.value))) } : x)))} /></label>
                <span className="muted">{k.scale <= 1 ? "full frame" : `at ${Math.round(k.cx * 100)}%, ${Math.round(k.cy * 100)}%`}</span>
                <button type="button" className="link" title="Delete" onClick={() => commit(keys.filter((_, j) => j !== i))}>✕</button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
