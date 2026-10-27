import { useState, type ReactNode } from "react";

/** 右側編輯面板的頁籤，依 §5.13（D33）分四組，組之間畫分隔線 */
const TAB_GROUPS: { id: string; label: string }[][] = [
  [{ id: "transcript", label: "Transcript" }, { id: "director", label: "AI Director" }, { id: "media", label: "Media" }],
  [{ id: "vibe", label: "Vibe FX" }, { id: "scene3d", label: "3D Scene" }, { id: "zoom", label: "Zoom" }, { id: "mask", label: "Mask" }, { id: "style", label: "Caption Style" }, { id: "audio", label: "Sound & Music" }],
  [{ id: "inspector", label: "Inspector" }],
  [{ id: "export", label: "Export" }, { id: "publish", label: "Publish Kit" }],
];

/**
 * 右側編輯面板（D33）。
 * tabs：由 App 組好的頁籤內容（頁籤 id → 內容，例如 transcript、media、vibe；transcriptTools 放在逐字稿上方）；initialTab：一開始打開的頁籤（空專案先開素材頁籤）
 */
export function EditPanel({ tabs, initialTab }: { tabs: Record<string, ReactNode>; initialTab: string }) {
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
          ? <>{tabs.transcriptTools}{tabs.transcript}</>
          : tabs[tab] ?? <p className="muted placeholder">{current.label} — coming soon</p>}
      </div>
    </aside>
  );
}
