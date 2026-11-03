import { useEffect, useState, type ReactNode } from "react";

/** 一個子頁籤（葉節點）：id 是內容的鍵，App 的 tabs 與 openTab 都用它 */
interface Leaf {
  id: string;
  label: string;
}

/** 大類別：只有一個子頁籤的不顯示子頁籤列 */
interface Group {
  id: string;
  label: string;
  leaves: Leaf[];
}

/**
 * 右側面板的大類別與子頁籤（開發者 2026-10-28：依功能種類分組，取代 §5.13 D33 原本的四組平鋪頁籤）。
 * 特效下再分 2D／3D／放大／遮罩／音效。
 */
export const TAB_GROUPS: Group[] = [
  { id: "media", label: "Media", leaves: [{ id: "media", label: "Media" }] },
  { id: "transcript", label: "Transcript", leaves: [{ id: "transcript", label: "Transcript" }, { id: "style", label: "Caption Style" }] },
  {
    id: "effects", label: "Effects",
    leaves: [{ id: "vibe", label: "2D" }, { id: "vibe3d", label: "3D" }, { id: "zoom", label: "Zoom" }, { id: "mask", label: "Mask" }, { id: "textures", label: "Textures" }, { id: "audio", label: "Sound" }, { id: "intro", label: "Intro" }, { id: "revoice", label: "Re-voice" }, { id: "color", label: "Color" }],
  },
  { id: "inspector", label: "Inspector", leaves: [{ id: "inspector", label: "Inspector" }] },
  { id: "director", label: "AI Director", leaves: [{ id: "director", label: "AI Director" }] },
  { id: "export", label: "Export", leaves: [{ id: "export", label: "Export" }, { id: "publish", label: "Publish Kit" }] },
];

/** 子頁籤屬於哪個大類別（找不到就回第一個大類別） */
export function groupOf(leafId: string): Group {
  return TAB_GROUPS.find((g) => g.leaves.some((l) => l.id === leafId)) ?? TAB_GROUPS[0];
}

/**
 * 右側編輯面板（D33）。
 * tabs：由 App 組好的子頁籤內容（id → 內容；transcriptTools 放在逐字稿上方）；initialTab：一開始打開的子頁籤（空專案先開素材）
 */
export function EditPanel({ tabs, initialTab, request }: {
  tabs: Record<string, ReactNode>;
  initialTab: string;
  /** 外面要求切到某個子頁籤（seq 每次要求加一，同一個頁籤也能再切一次） */
  request?: { tab: string; seq: number } | null;
}) {
  /** 目前打開的子頁籤 */
  const [tab, setTab] = useState(initialTab);
  /** 各大類別上次打開的子頁籤（回到大類別時打開它） */
  const [lastLeaf, setLastLeaf] = useState<Record<string, string>>({});
  /** 切到某個子頁籤，並記住它是所屬大類別的最後一個 */
  const open = (leafId: string) => {
    setTab(leafId);
    setLastLeaf((m) => ({ ...m, [groupOf(leafId).id]: leafId }));
  };
  useEffect(() => { if (request) open(request.tab); }, [request]);
  const group = groupOf(tab);
  const current = group.leaves.find((l) => l.id === tab) ?? group.leaves[0];
  return (
    <aside className="edit-panel">
      <nav className="tabs">
        {TAB_GROUPS.map((g) => (
          <button key={g.id} className={g.id === group.id ? "active" : ""} data-group={g.id} onClick={() => open(lastLeaf[g.id] ?? g.leaves[0].id)}>{g.label}</button>
        ))}
      </nav>
      {group.leaves.length > 1 && (
        <nav className="subtabs">
          {group.leaves.map((l) => (
            <button key={l.id} className={l.id === current.id ? "active" : ""} data-tab={l.id} onClick={() => open(l.id)}>{l.label}</button>
          ))}
        </nav>
      )}
      <div className="tab-pane" data-pane={current.id}>
        {current.id === "transcript"
          ? <>{tabs.transcriptTools}{tabs.transcript}</>
          : tabs[current.id] ?? <p className="muted placeholder">{current.label} — coming soon</p>}
      </div>
    </aside>
  );
}
