// 素材頁籤（§5.13）：匯入、列出素材（縮圖、長度、準備狀態），拖到時間軸的某條軌道上，或雙擊加到 V1 結尾。
// 拖曳用滑鼠事件自己做，不用 HTML5 拖放：Windows 上 Tauri 接管了 WebView2 的拖放，HTML5 drag 事件不可靠。
import { useEffect, useState, type Dispatch } from "react";
import type { Project } from "../core/model";
import type { Engine } from "../engine/Engine";
import { formatTimecode, projectDuration, v1Id, type Action } from "./state";
import type { Library } from "./useMediaLibrary";

/** 拖曳中的素材與滑鼠位置 */
interface MediaDrag {
  mediaId: string;
  x: number;
  y: number;
}

/** 滑鼠底下的軌道與時間（不在時間軸上回 null） */
export function dropTarget(x: number, y: number, pxPerSecond: number): { trackId: string; t: number } | null {
  const row = document.elementFromPoint(x, y)?.closest<HTMLElement>(".track-row[data-track-id]");
  if (!row) return null;
  return { trackId: row.dataset.trackId!, t: Math.max(0, (x - row.getBoundingClientRect().left) / pxPerSecond) };
}

/** 素材頁籤 */
export function MediaTab({ project, library, engine, pxPerSecond, onImport, dispatch }: {
  project: Project;
  library: Library;
  engine: Engine;
  pxPerSecond: number;
  onImport: () => void;
  dispatch: Dispatch<Action>;
}) {
  const [drag, setDrag] = useState<MediaDrag | null>(null);

  // 拖曳中追蹤滑鼠；放開時放到滑鼠底下的軌道
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => setDrag((d) => (d ? { ...d, x: e.clientX, y: e.clientY } : d));
    const onUp = (e: MouseEvent) => {
      setDrag(null);
      const target = dropTarget(e.clientX, e.clientY, pxPerSecond);
      if (target) dispatch({ type: "commit", edits: [{ kind: "place", mediaId: drag.mediaId, ...target }] });
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [drag, pxPerSecond, dispatch]);

  /** 雙擊：影片與圖片接在 V1 結尾，聲音放 A2 播放頭以後不擋人的地方（目前就放片尾） */
  const addToEnd = (mediaId: string) => {
    const media = project.media.find((m) => m.id === mediaId);
    if (!media) return;
    const trackId = media.kind === "audio" ? "A2" : v1Id(project)!;
    dispatch({ type: "commit", edits: [{ kind: "place", mediaId, trackId, t: media.kind === "audio" ? 0 : projectDuration(project) }] });
  };

  const failed = [...library.items.entries()].filter(([id, item]) => item.status === "failed" && !project.media.some((m) => m.id === id));
  const target = drag ? dropTarget(drag.x, drag.y, pxPerSecond) : null;

  return (
    <div className="media-tab">
      <div className="media-actions">
        <button onClick={onImport} data-testid="import-media">＋ Import media</button>
        <span className="muted">or drop files anywhere{engine.capabilities.anyFormatImport ? "" : " (H.264/AAC MP4, MOV, images, MP3/WAV/M4A)"}</span>
      </div>
      {project.media.length === 0 && failed.length === 0 && <p className="muted placeholder">No media yet.</p>}
      <ul className="media-list">
        {project.media.map((m) => {
          const item = library.items.get(m.id);
          return (
            <li
              key={m.id}
              className={`media-item ${m.kind}${m.offline ? " offline" : ""}`}
              data-media-id={m.id}
              onMouseDown={(e) => { e.preventDefault(); setDrag({ mediaId: m.id, x: e.clientX, y: e.clientY }); }}
              onDoubleClick={() => addToEnd(m.id)}
              title="Drag to a track, or double-click to add at the end"
            >
              <div className="media-thumb">{item?.thumbnailUrl ? <img src={item.thumbnailUrl} alt="" draggable={false} /> : <span>{m.kind === "audio" ? "♪" : "▣"}</span>}</div>
              <div className="media-meta">
                <span className="media-name">{m.name ?? m.id}</span>
                <span className="muted">
                  {m.kind === "image" ? `${m.width}×${m.height}` : formatTimecode(m.duration).slice(3)}
                  {m.kind === "video" && m.height ? ` · ${m.height}p` : ""}
                </span>
                {m.offline && (
                  <span className="media-status offline" data-testid="media-offline" title={m.path ? `Original file: ${m.path}` : "The original file can't be found"}>
                    Media offline{m.path ? ` · ${m.path}` : ""}
                  </span>
                )}
                <button
                  className={`media-remove${m.offline ? " visible" : ""}`} data-testid="media-remove" title="Remove from project (its clips too; the file on disk is kept). Ctrl+Z to undo."
                  onMouseDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    const used = project.clips.filter((c) => c.mediaId === m.id).length;
                    if (used && !window.confirm(`Remove ${m.name ?? "this media"} and its ${used} clip${used > 1 ? "s" : ""} from the timeline?`)) return;
                    dispatch({ type: "commit", edits: [{ kind: "removeMedia", mediaId: m.id }] });
                  }}
                >Remove</button>
                {!m.offline && item && item.status !== "ready" && (
                  <span className={`media-status ${item.status}`} data-testid="media-status">
                    {item.status === "failed" ? item.error : `Preparing ${Math.round(item.progress * 100)}%`}
                  </span>
                )}
              </div>
            </li>
          );
        })}
        {failed.map(([id, item]) => (
          <li key={id} className="media-item failed">
            <div className="media-thumb"><span>⚠</span></div>
            <div className="media-meta">
              <span className="media-name">{item.name}</span>
              <span className="media-status failed">{item.error}</span>
            </div>
          </li>
        ))}
      </ul>
      {drag && (
        <div className="media-ghost" style={{ left: drag.x + 12, top: drag.y + 12 }}>
          {project.media.find((m) => m.id === drag.mediaId)?.name}
          {target ? ` → ${target.trackId} @ ${formatTimecode(target.t).slice(3)}` : ""}
        </div>
      )}
    </div>
  );
}
