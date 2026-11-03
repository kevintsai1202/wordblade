// 專案資料夾（spec §5.13、D41）的狀態與動作：開著哪個專案、另存新專案、開舊專案、最近開啟、編輯後 2 秒自動存進 project.json、
// 開專案時找不到的素材。存與開的邏輯在 project/session.ts（可單元測試），這裡只接 React 與 Engine。
import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import type { Media, Project } from "../core/model";
import { shouldSave } from "../core/session";
import type { Engine, ProjectLocation } from "../engine/Engine";
import { RECENT_KEY, loadProjectText, projectSave, pushRecent, relinkMissing, type MissingMedia, type RecentProject } from "../project/session";
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
  /** 開專案時找不到的素材 */
  const [missing, setMissing] = useState<MissingMedia[]>([]);
  /** 素材指紋（同一支只算一次） */
  const fingerprints = useRef(new Map<string, string>());
  /** 剛載入的專案不要立刻回存（沒改東西） */
  const justLoaded = useRef(false);
  /** 已經寫進 .data 的檔案內容（相對路徑 → 內容；沒變就不重寫） */
  const written = useRef(new Map<string, string>());

  // 讓 Engine 知道開著哪個專案（產生的音檔寫進它的 .data\generated\）
  useEffect(() => {
    engine.setProjectLocation(location);
  }, [engine, location]);

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
      // 遮罩取樣等先寫進 .data（內容沒變的不重寫），再寫 project.json
      const { text, files } = await projectSave(p, loc, fingerprints.current, (m) => engine.mediaFingerprint(m), Date.now());
      for (const [rel, content] of Object.entries(files)) {
        const key = `${loc.dir}|${rel}`;
        if (written.current.get(key) === content) continue;
        await engine.writeData(loc, rel, content);
        written.current.set(key, content);
      }
      await engine.writeProject(loc, text);
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
    const result = await loadProjectText(opened.text, opened.location, (m, c, fp) => engine.locateMedia(m, c, fp), (rel) => engine.readData(opened.location, rel));
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
  const open = useCallback(async () => {
    try {
      return await load(await engine.openProject());
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  }, [engine, load]);
  /** 開最近的專案 */
  const reopen = useCallback(async (loc: ProjectLocation) => {
    const opened = await engine.reopenProject(loc);
    return opened ? load(opened) : `Can't open ${loc.dir} — it may have been moved or deleted.`;
  }, [engine, load]);

  /**
   * 重新連結一支找不到的素材：使用者選檔，同資料夾裡其他找不到的素材一起找回；
   * 換掉路徑（舊的代理檔不用）、重新準備，改動會由上面的自動存檔寫進 project.json。回傳錯誤訊息或 null。
   */
  const relink = useCallback(async (id: string): Promise<string | null> => {
    const target = project.media.find((m) => m.id === id);
    if (!target) return null;
    const [source] = await engine.pickFiles();
    if (!source) return null;
    if (source.kind !== "path") {
      // 網頁版：選的檔案直接接上這一支（沒有路徑可以找同資料夾的其他支）
      const handleKey = await engine.adoptFile(target, source);
      if (!handleKey) return `Can't use ${source.name}.`;
      // 桌面版存的素材原本沒有 handleKey：補上，之後預覽與存檔都用它
      dispatch({ type: "patchMedia", id: target.id, patch: { handleKey, offline: undefined } });
      enqueuePrepare({ ...target, handleKey });
      setMissing((list) => list.filter((x) => x.id !== target.id));
      return null;
    }
    const found = await relinkMissing(target, source.path, project.media, missing, (m, c, fp) => engine.locateMedia(m, c, fp));
    if (!found.length) return `Can't open ${source.name}.`;
    for (const { id: mid, path } of found) {
      const m = project.media.find((x) => x.id === mid)!;
      dispatch({ type: "patchMedia", id: mid, patch: { path, proxyPath: undefined, offline: undefined } });
      enqueuePrepare({ ...m, path, proxyPath: undefined });
    }
    setMissing((list) => list.filter((x) => !found.some((f) => f.id === x.id)));
    return null;
  }, [engine, project.media, missing, dispatch, enqueuePrepare]);

  /**
   * 網頁版：授權一個素材資料夾（素材在專案外面），然後把所有找不到的素材在裡面重找一次；找到的清掉離線標示。
   * 回傳錯誤訊息或 null。
   */
  const allowFolder = useCallback(async (): Promise<string | null> => {
    if (!(await engine.grantMediaFolder())) return null;
    const found: string[] = [];
    for (const miss of missing) {
      const m = project.media.find((x) => x.id === miss.id);
      if (!m) continue;
      const hit = await engine.locateMedia(m, [], miss.fingerprint);
      if (!hit) continue;
      dispatch({ type: "patchMedia", id: m.id, patch: { handleKey: hit.handleKey, offline: undefined } });
      enqueuePrepare({ ...hit, offline: undefined });
      found.push(m.id);
    }
    setMissing((list) => list.filter((x) => !found.includes(x.id)));
    return found.length ? null : "None of the missing files are in that folder.";
  }, [engine, missing, project.media, dispatch, enqueuePrepare]);

  /** 外面（網頁版還原上次工作）找不到的素材交給這裡，沿用同一套「Locate…／Allow folder」重新連結介面 */
  const markMissing = useCallback((list: MissingMedia[]) => setMissing(list), []);

  return { location, status, recent, missing, saveAs, open, reopen, relink, allowFolder, markMissing, dismissMissing: () => setMissing([]) };
}
