// 專案資料夾（spec §5.13、D41）的狀態與動作：開著哪個專案、另存新專案、開舊專案、最近開啟、編輯後 2 秒自動存進 project.json、
// 開專案時找不到的素材。存與開的邏輯在 project/session.ts（可單元測試），這裡只接 React 與 Engine。
import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import type { Media, Project } from "../core/model";
import { shouldSave } from "../core/session";
import type { Engine, ProjectLocation } from "../engine/Engine";
import { RECENT_KEY, loadProjectText, projectText, pushRecent, type RecentProject } from "../project/session";
import type { Action } from "./state";

/** 讀最近開啟（讀不到回空） */
function loadRecent(): RecentProject[] {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** 專案資料夾 */
export function useProjectFolder(opts: {
  engine: Engine;
  project: Project;
  /** 復原歷史裡有幾步（判斷使用者編輯過沒） */
  edits: number;
  /** 目前是不是還沒編輯過的示範專案 */
  isDemo: boolean;
  dispatch: Dispatch<Action>;
  /** 換專案前釋放舊素材、換好後在背景準備新素材（useMediaLibrary） */
  reset: (media: Media[]) => void;
  enqueuePrepare: (media: Media) => void;
}) {
  const { engine, project, edits, isDemo, dispatch, reset, enqueuePrepare } = opts;
  const [location, setLocation] = useState<ProjectLocation | null>(null);
  /** 存檔狀態：saving、saved（含時間）、error */
  const [status, setStatus] = useState<{ kind: "saving" | "saved" | "error"; at?: number; message?: string } | null>(null);
  const [recent, setRecent] = useState<RecentProject[]>(loadRecent);
  /** 開專案時找不到的素材名稱 */
  const [missing, setMissing] = useState<string[]>([]);
  /** 素材指紋（同一支只算一次） */
  const fingerprints = useRef(new Map<string, string>());
  /** 剛載入的專案不要立刻回存（沒改東西） */
  const justLoaded = useRef(false);

  /** 記進最近開啟 */
  const remember = useCallback((loc: ProjectLocation) => {
    setRecent((list) => {
      const next = pushRecent(list, loc, Date.now());
      try {
        localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      } catch {
        /* 存不了就算了 */
      }
      return next;
    });
  }, []);

  /** 寫 project.json */
  const save = useCallback(async (loc: ProjectLocation, p: Project) => {
    setStatus({ kind: "saving" });
    try {
      await engine.writeProject(loc, await projectText(p, loc, fingerprints.current, (m) => engine.mediaFingerprint(m), Date.now()));
      setStatus({ kind: "saved", at: Date.now() });
    } catch (e) {
      setStatus({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }, [engine]);

  // 開著專案資料夾時：使用者編輯後 2 秒存進 project.json
  useEffect(() => {
    if (!location) return;
    if (justLoaded.current) {
      justLoaded.current = false;
      return;
    }
    if (!shouldSave(project, edits, isDemo)) return;
    const timer = setTimeout(() => void save(location, project), 2000);
    return () => clearTimeout(timer);
  }, [location, project, edits, isDemo, save]);

  /** 另存成新的專案資料夾（name：專案名稱）；之後的編輯都存進那裡 */
  const saveAs = useCallback(async (name: string) => {
    const loc = await engine.createProject(name);
    if (!loc) return;
    setLocation(loc);
    remember(loc);
    await save(loc, project);
  }, [engine, project, remember, save]);

  /** 載入讀到的專案：找回素材、換掉目前的專案 */
  const load = useCallback(async (opened: { location: ProjectLocation; text: string } | null): Promise<string | null> => {
    if (!opened) return null;
    const result = await loadProjectText(opened.text, opened.location, (m, c, fp) => engine.locateMedia(m, c, fp));
    if ("error" in result) return result.error;
    reset(project.media);
    justLoaded.current = true;
    dispatch({ type: "load", project: result.project });
    for (const m of result.project.media) enqueuePrepare(m);
    setLocation(opened.location);
    setMissing(result.missing);
    setStatus({ kind: "saved", at: result.savedAt });
    remember(opened.location);
    return null;
  }, [engine, project.media, reset, dispatch, enqueuePrepare, remember]);

  /** 開舊專案（對話框） */
  const open = useCallback(async () => load(await engine.openProject()), [engine, load]);
  /** 開最近的專案 */
  const reopen = useCallback(async (loc: ProjectLocation) => {
    const opened = await engine.reopenProject(loc);
    return opened ? load(opened) : `Can't open ${loc.dir} — it may have been moved or deleted.`;
  }, [engine, load]);

  return { location, status, recent, missing, saveAs, open, reopen, dismissMissing: () => setMissing([]) };
}
