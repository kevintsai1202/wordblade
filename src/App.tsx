import { useEffect, useMemo, useReducer, useState } from "react";
import { ensureAudioGraph } from "./audio/audioGraph";
import { buildCaptions } from "./core/captions";
import { emptyProject } from "./core/media";
import { setEffectParams } from "./core/effects";
import { PluginService } from "./anim/pluginService";
import { createEngine } from "./engine/createEngine";
import { demoProject } from "./ui/demoProject";
import { EditPanel } from "./ui/EditPanel";
import { MediaTab } from "./ui/MediaTab";
import { PreviewPane } from "./ui/PreviewPane";
import { initialState, keyToAction, projectDuration, reducer } from "./ui/state";
import { Timeline } from "./ui/Timeline";
import { useMediaLibrary } from "./ui/useMediaLibrary";
import { VibeTab } from "./ui/VibeTab";
import { InspectorTab } from "./ui/InspectorTab";
import "./App.css";

/** 網址帶 ?demo=1 就直接開示範專案（e2e 用）；否則開空專案 */
const START_WITH_DEMO = new URLSearchParams(window.location.search).has("demo");

/** 會開始播放的熱鍵：要在這個手勢裡建立 Web Audio（AudioContext 要使用者手勢才會 running） */
const PLAY_KEYS = new Set([" ", "l", "j"]);

/** 主畫面（D33，照 SubTutor 的混合模式）：上方標題列、左側預覽、右側編輯面板、下方時間軸、最底下熱鍵提示 */
function App() {
  /** 目前執行環境的 Engine（桌面版或網頁版），整個 app 只建一次 */
  const engine = useMemo(() => createEngine(), []);
  /** 插件沙盒（2D 特效的畫格、試跑），整個 app 共用一個 */
  const plugins = useMemo(() => new PluginService(), []);
  const [state, dispatch] = useReducer(reducer, START_WITH_DEMO ? demoProject() : emptyProject(), initialState);
  const project = state.history.present;
  /** 字幕由逐字稿算出（D26），專案一變就重算 */
  const captions = useMemo(() => buildCaptions(project), [project]);
  const { library, importSources, enqueuePrepare, reset } = useMediaLibrary(engine, dispatch);
  /** AI 預覽中的特效設定（「用說的」的提議，還沒寫進專案；預覽畫面用它） */
  const [aiPreview, setAiPreview] = useState<{ effectId: string; params: Record<string, unknown> } | null>(null);
  /** 預覽畫面看到的專案：有 AI 預覽時套上提議 */
  const shownProject = useMemo(() => {
    if (!aiPreview) return project;
    const effect = project.effects.find((e) => e.id === aiPreview.effectId);
    return effect ? setEffectParams(project, effect.id, { ...effect.params, params: aiPreview.params }) : project;
  }, [project, aiPreview]);
  // 選取的特效換了就結束 AI 預覽
  useEffect(() => { if (aiPreview && aiPreview.effectId !== state.selectedEffectId) setAiPreview(null); }, [state.selectedEffectId, aiPreview]);
  /** 標題列的狀態訊息（例如找不到示範素材） */
  const [notice, setNotice] = useState<string | null>(null);

  // Resolve 風格熱鍵；焦點在輸入框時不攔
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const action = keyToAction(e, state);
      if (action) {
        e.preventDefault();
        if (PLAY_KEYS.has(e.key.toLowerCase())) ensureAudioGraph();
        dispatch(action);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state]);

  /**
   * 載入示範專案：素材資料夾由 Engine 決定（Windows 版找 repo 的 samples/ 並放行讀取；安裝版沒有就提示）。
   * 換專案前釋放舊素材的資源，載入後照常在背景準備（縮圖、波形、代理檔）。
   */
  const onLoadDemo = async () => {
    const root = await engine.demoMediaRoot();
    if (root === null) {
      setNotice("Sample media not found (the samples/ folder only exists in the repo).");
      return;
    }
    setNotice(null);
    const demo = demoProject(root);
    reset(project.media);
    dispatch({ type: "load", project: demo });
    for (const m of demo.media) enqueuePrepare(m);
  };

  /** 開選檔對話框並匯入 */
  const onImport = async () => importSources(await engine.pickFiles());

  return (
    <div className="app">
      <header className="title-bar">
        <span className="brand">WordBlade</span>
        <span className="project-path">{project.media.length ? "untitled project" : "new project"}</span>
        <button title="Open the sample project (local samples/ folder)" data-testid="load-demo" onClick={() => void onLoadDemo()}>Load demo</button>
        {notice && <span className="muted" data-testid="notice">{notice}</span>}
        <span className="spacer" />
        <span className="muted" data-testid="engine-kind">Engine: {engine.kind}</span>
        <button disabled title="Export — coming soon">Export</button>
      </header>
      <main className="workspace">
        <PreviewPane project={shownProject} playhead={state.playhead} playing={state.playing} rate={state.rate} duration={projectDuration(project)} captions={captions} engine={engine} library={library} plugins={plugins} selectedEffectId={state.selectedEffectId} dispatch={dispatch} />
        <EditPanel
          captions={captions}
          playhead={state.playhead}
          dispatch={dispatch}
          initialTab={START_WITH_DEMO ? "transcript" : "media"}
          tabs={{
            media: <MediaTab project={project} library={library} engine={engine} pxPerSecond={state.pxPerSecond} onImport={() => void onImport()} dispatch={dispatch} />,
            vibe: <VibeTab plugins={plugins} playhead={state.playhead} dispatch={dispatch} />,
            inspector: <InspectorTab project={project} effectId={state.selectedEffectId} dispatch={dispatch} preview={aiPreview} onPreview={setAiPreview} />,
          }}
        />
      </main>
      <Timeline state={state} dispatch={dispatch} captions={captions} library={library} />
      <footer className="status-bar">
        Space play · J / K / L reverse / stop / forward · Click to select · Delete ripple delete · Ctrl+B split at playhead · Ctrl+Z / Ctrl+Shift+Z undo / redo · ← → frame · ↑ ↓ edit points · Ctrl+wheel zoom
      </footer>
    </div>
  );
}

export default App;
