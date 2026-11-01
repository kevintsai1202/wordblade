// 歡迎畫面（2026-11-01 開發者要求，從 UI/UX 角度：一開始就知道怎麼建專案、怎麼回到上次的專案）：
// 還沒開專案、素材庫也是空的時候蓋在預覽區上。新專案（輸入名稱 → 選放在哪裡）、開專案、最近專案（點一下就開）、
// 還原瀏覽器裡沒存成專案的上次工作、範例專案。網頁版開最近專案要使用者點一下才能拿檔案權限，所以第一筆做成「繼續」大按鈕。
import { useState } from "react";
import type { RecentProject } from "../project/session";

/** 歡迎畫面 */
export function WelcomePanel({ recent, projectFolders, onNew, onOpen, onReopen, onSample, lastSession, onRestore }: {
  recent: RecentProject[];
  /** 這個環境能不能用專案資料夾（網頁版要 Chrome／Edge 的 File System Access） */
  projectFolders: boolean;
  onNew: (name: string) => void;
  onOpen: () => void;
  onReopen: (r: RecentProject) => void;
  onSample: () => void;
  /** 瀏覽器裡的上次工作（沒存成專案的）：片段數與時間；沒有就 null */
  lastSession: { clips: number; savedAt: number } | null;
  onRestore: () => void;
}) {
  /** 新專案的名稱（null：還沒按 New project） */
  const [name, setName] = useState<string | null>(null);
  const [first, ...rest] = recent;
  return (
    <div className="welcome" data-testid="welcome">
      <h2>WordBlade</h2>
      {projectFolders ? (
        <>
          {first && (
            <button className="welcome-continue primary" data-testid="welcome-continue" onClick={() => onReopen(first)}>
              Continue “{first.name}”
              <span className="muted">{new Date(first.openedAt).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
            </button>
          )}
          <div className="welcome-actions">
            {name === null
              ? <button data-testid="welcome-new" onClick={() => setName("Untitled")}>＋ New project…</button>
              : (
                <form className="save-as" onSubmit={(e) => { e.preventDefault(); const n = name.trim(); setName(null); if (n) onNew(n); }}>
                  <input autoFocus data-testid="welcome-name" value={name} maxLength={80} placeholder="Project name" onChange={(e) => setName(e.target.value)} />
                  <button type="submit">Choose where to save…</button>
                  <button type="button" onClick={() => setName(null)}>✕</button>
                </form>
              )}
            <button data-testid="welcome-open" onClick={onOpen}>Open project…</button>
          </div>
          <p className="muted">A project is a folder (<code>Name.wordblade</code>). Media stays where it is — the project only links to it. Edits save automatically.</p>
          {rest.length > 0 && (
            <ul className="welcome-recent" data-testid="welcome-recent">
              {rest.map((r) => (
                <li key={r.dir}>
                  <button className="link" onClick={() => onReopen(r)} title={r.dir}>{r.name}</button>
                  <span className="muted">{new Date(r.openedAt).toLocaleDateString()}</span>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <p className="muted">This browser can't save project folders (use Chrome or Edge). Your work is kept in this browser automatically.</p>
      )}
      <div className="welcome-actions">
        {lastSession && (
          <button data-testid="welcome-restore" onClick={onRestore}>
            Restore unsaved work ({lastSession.clips} clips, {new Date(lastSession.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })})
          </button>
        )}
        <button className="link" onClick={onSample}>Try the sample project</button>
      </div>
      <p className="muted">Or just import media to start without a project.</p>
    </div>
  );
}
