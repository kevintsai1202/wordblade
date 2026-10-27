import { useState, type Dispatch, type ReactNode } from "react";
import type { Caption } from "../core/captions";
import { formatTimecode, type Action } from "./state";

/** 右側編輯面板的頁籤，依 §5.13（D33）分四組，組之間畫分隔線 */
const TAB_GROUPS: { id: string; label: string }[][] = [
  [{ id: "transcript", label: "Transcript" }, { id: "director", label: "AI Director" }, { id: "media", label: "Media" }],
  [{ id: "vibe", label: "Vibe FX" }, { id: "scene3d", label: "3D Scene" }, { id: "zoom", label: "Zoom" }, { id: "mask", label: "Mask" }, { id: "style", label: "Caption Style" }, { id: "audio", label: "Sound & Music" }],
  [{ id: "inspector", label: "Inspector" }],
  [{ id: "export", label: "Export" }, { id: "publish", label: "Publish Kit" }],
];

/** 逐字稿頁籤：依字幕分段列出，點一段把播放頭移過去，播放頭所在的那段高亮 */
function TranscriptTab({ captions, playhead, dispatch }: { captions: Caption[]; playhead: number; dispatch: Dispatch<Action> }) {
  return (
    <ol className="transcript">
      {captions.map((c) => (
        <li key={c.id} className={playhead >= c.start && playhead < c.end ? "active" : ""} onClick={() => dispatch({ type: "seek", time: c.start })}>
          <span className="timecode">{formatTimecode(c.start).slice(3)}</span>
          <span className="caption-text">{c.lines.join(" ")}</span>
        </li>
      ))}
    </ol>
  );
}

/**
 * 右側編輯面板（D33）。
 * tabs：由 App 組好的頁籤內容（頁籤 id → 內容，例如 media、vibe）；initialTab：一開始打開的頁籤（空專案先開素材頁籤）
 */
export function EditPanel({ captions, playhead, dispatch, tabs, initialTab }: { captions: Caption[]; playhead: number; dispatch: Dispatch<Action>; tabs: Record<string, ReactNode>; initialTab: string }) {
  /** 目前打開的頁籤 */
  const [tab, setTab] = useState(initialTab);
  const current = TAB_GROUPS.flat().find((t) => t.id === tab)!;
  return (
    <aside className="edit-panel">
      <div className="panel-title">Edit panel</div>
      <nav className="tabs">
        {TAB_GROUPS.map((group, g) => (
          <div key={g} className="tab-group">
            {group.map((t) => (
              <button key={t.id} className={t.id === tab ? "active" : ""} data-tab={t.id} onClick={() => setTab(t.id)}>{t.label}</button>
            ))}
          </div>
        ))}
      </nav>
      <div className="tab-pane">
        {tab === "transcript"
          ? <TranscriptTab captions={captions} playhead={playhead} dispatch={dispatch} />
          : tabs[tab] ?? <p className="muted placeholder">{current.label} — coming soon</p>}
      </div>
    </aside>
  );
}
