import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
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
import { ExportTab } from "./ui/ExportTab";
import { TranscribePanel } from "./ui/TranscribePanel";
import { CaptionStyleTab } from "./ui/CaptionStyleTab";
import { TranscriptTab } from "./ui/TranscriptTab";
import { CleanupPanel } from "./ui/CleanupPanel";
import { ZoomTab } from "./ui/ZoomTab";
import { ZoomEditOverlay } from "./ui/ZoomEditOverlay";
import type { ZoomEdit } from "./ui/ZoomBands";
import { zoomFromRange } from "./core/zoom";
import { clipEnd, timelineToSource } from "./core/timeline";
import { useLayout } from "./ui/layout";
import { isBusy } from "./core/busy";
import { ThumbScheduler, ThumbStore } from "./media/thumbStore";
import { Splitter } from "./ui/Splitter";
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
  /** 區塊大小（三條分隔線，記在這台電腦） */
  const { layout, set: setLayout, reset: resetLayout } = useLayout();
  const [state, dispatch] = useReducer(reducer, START_WITH_DEMO ? demoProject() : emptyProject(), initialState);
  const project = state.history.present;
  /** 縮圖序列（D39）：匯入時做第一層，之後空檔（沒播放、沒有重工作）再做細層 */
  const thumbs = useMemo(() => new ThumbStore(engine), [engine]);
  /** 排程器讀的最新播放狀態 */
  const playingRef = useRef(state.playing);
  playingRef.current = state.playing;
  useEffect(() => {
    const scheduler = new ThumbScheduler(thumbs, () => !playingRef.current && !isBusy());
    scheduler.start();
    return () => scheduler.stop();
  }, [thumbs]);
  // 素材清單變了（匯入、代理檔做好、換專案）就同步給縮圖序列
  useEffect(() => { void thumbs.sync(project.media); }, [thumbs, project.media]);
  /** 字幕由逐字稿算出（D26），專案一變就重算 */
  const captions = useMemo(() => buildCaptions(project), [project]);
  const { library, importSources, enqueuePrepare, reset } = useMediaLibrary(engine, dispatch, thumbs);
  /** AI 預覽中的特效設定（「用說的」的提議，還沒寫進專案；預覽畫面用它） */
  const [aiPreview, setAiPreview] = useState<{ effectId: string; params: Record<string, unknown> } | null>(null);
  /** 要求右側面板切到某個頁籤（範圍動作列的「特效」「放大」） */
  const [tabRequest, setTabRequest] = useState<{ tab: string; seq: number } | null>(null);
  const openTab = (tab: string) => setTabRequest((r) => ({ tab, seq: (r?.seq ?? 0) + 1 }));
  /** 局部放大：正在調的那一段與選取的路徑點（照字導字演：點放大條或「Adjust」進入，Done／Esc 離開） */
  const [zoomEdit, setZoomEdit] = useState<ZoomEdit | null>(null);
  const editingZoom = zoomEdit ? project.zooms?.find((z) => z.id === zoomEdit.zoomId) ?? null : null;
  const v1Track = project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  /** 播放頭所在、用到這段放大的素材的 V1 片段 */
  const zoomClip = editingZoom ? project.clips.find((c) => c.trackId === v1Track && c.mediaId === editingZoom.mediaId && !c.freeze && c.start <= state.playhead && state.playhead < clipEnd(c)) ?? null : null;
  // 那一段被刪了（或復原掉了）就離開調框
  useEffect(() => { if (zoomEdit && !editingZoom) setZoomEdit(null); }, [zoomEdit, editingZoom]);
  // 播放頭離開選取的路徑點（超過 2 格）就取消選取，拖框改回整段平移（照字導字演）
  useEffect(() => {
    if (!zoomEdit || zoomEdit.point === null || !editingZoom) return;
    const point = editingZoom.path[zoomEdit.point];
    const src = zoomClip ? timelineToSource(zoomClip, state.playhead) : null;
    if (!point || src === null || Math.abs(src - point.src) > 2 / 30) setZoomEdit({ ...zoomEdit, point: null });
  }, [state.playhead, zoomEdit, editingZoom, zoomClip]);
  /** 範圍動作列的「放大」：從選的範圍建立一段放大，進入調框 */
  const createZoom = () => {
    if (!state.range) return;
    const zoom = zoomFromRange(project, state.range, `zoom-${crypto.randomUUID().slice(0, 8)}`);
    if (!zoom) {
      setNotice("Start the range on a clip in V1 to zoom.");
      return;
    }
    dispatch({ type: "commit", edits: [{ kind: "addZoom", zoom }] });
    dispatch({ type: "clearRange" });
    dispatch({ type: "seek", time: state.range.start });
    setZoomEdit({ zoomId: zoom.id, point: null });
    openTab("zoom");
  };
  /** 預覽畫面看到的專案：有 AI 預覽時套上提議 */
  const shownProject = useMemo(() => {
    // 調框中：預覽顯示沒放大的畫面（照字導字演），才看得到要框哪裡
    const base = zoomEdit ? { ...project, zooms: (project.zooms ?? []).map((z) => (z.id === zoomEdit.zoomId ? { ...z, enabled: false } : z)) } : project;
    if (!aiPreview) return base;
    const effect = base.effects.find((e) => e.id === aiPreview.effectId);
    return effect ? setEffectParams(base, effect.id, { ...effect.params, params: aiPreview.params }) : base;
  }, [project, aiPreview, zoomEdit?.zoomId]);
  // 選取的特效換了就結束 AI 預覽
  useEffect(() => { if (aiPreview && aiPreview.effectId !== state.selectedEffectId) setAiPreview(null); }, [state.selectedEffectId, aiPreview]);
  /** 標題列的狀態訊息（例如找不到示範素材） */
  const [notice, setNotice] = useState<string | null>(null);

  // Resolve 風格熱鍵；焦點在輸入框時不攔
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 焦點在輸入框時不攔；元件自己處理過的鍵（例如逐字稿的 Delete 剪字）也不攔
      if (e.defaultPrevented || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
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
    <div className="app" style={{ "--panel-w": `${layout.panelWidth}px`, "--timeline-h": `${layout.timelineHeight}px` } as CSSProperties}>
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
        <PreviewPane project={shownProject} playhead={state.playhead} playing={state.playing} rate={state.rate} playSeq={state.playSeq} duration={projectDuration(project)} captions={captions} engine={engine} library={library} plugins={plugins} thumbs={thumbs} selectedEffectId={state.selectedEffectId}
          overlay={editingZoom && zoomEdit ? (
            <ZoomEditOverlay
              zoom={editingZoom} clip={zoomClip} playhead={state.playhead} edit={zoomEdit}
              onCommit={(z) => dispatch({ type: "commit", edits: [{ kind: "setZoom", zoom: z }] })}
              onAddPoint={(src, cx, cy) => {
                // 2 格內已經有點就選那一點，否則加一點並選取
                const near = editingZoom.path.findIndex((p) => Math.abs(p.src - src) <= 2 / 30);
                if (near >= 0) { setZoomEdit({ ...zoomEdit, point: near }); return; }
                const path = [...editingZoom.path, { src, cx, cy }].sort((a, b) => a.src - b.src);
                dispatch({ type: "commit", edits: [{ kind: "setZoom", zoom: { ...editingZoom, path } }] });
                setZoomEdit({ ...zoomEdit, point: path.findIndex((p) => p.src === src) });
              }}
              onDone={() => setZoomEdit(null)}
              onDelete={() => { dispatch({ type: "commit", edits: [{ kind: "deleteZoom", zoomId: editingZoom.id }] }); setZoomEdit(null); }}
            />
          ) : null}
          dispatch={dispatch} />
        <Splitter axis="x" sign={-1} value={layout.panelWidth} onChange={(v) => setLayout("panelWidth", v)} onReset={() => resetLayout("panelWidth")} testId="split-panel" title="Drag to resize the edit panel" />
        <EditPanel
          request={tabRequest}
          initialTab={START_WITH_DEMO ? "transcript" : "media"}
          tabs={{
            media: <MediaTab project={project} library={library} engine={engine} pxPerSecond={state.pxPerSecond} onImport={() => void onImport()} dispatch={dispatch} />,
            vibe: <VibeTab dimension="2d" plugins={plugins} playhead={state.playhead} range={state.range} dispatch={dispatch} />,
            vibe3d: <VibeTab dimension="3d" plugins={plugins} playhead={state.playhead} range={state.range} dispatch={dispatch} />,
            transcript: <TranscriptTab project={project} captions={captions} playhead={state.playhead} dispatch={dispatch} />,
            transcriptTools: <><TranscribePanel project={project} engine={engine} envelopes={library.envelopes} dispatch={dispatch} /><CleanupPanel project={project} envelopes={library.envelopes} dispatch={dispatch} /></>,
            zoom: <ZoomTab project={project} edit={zoomEdit} onEdit={setZoomEdit} dispatch={dispatch} />,
            style: <CaptionStyleTab project={project} dispatch={dispatch} />,
            export: <ExportTab project={project} captions={captions} engine={engine} plugins={plugins} envelopes={library.envelopes} />,
            inspector: <InspectorTab project={project} effectId={state.selectedEffectId} clipId={state.selectedClipId} playhead={state.playhead} dispatch={dispatch} preview={aiPreview} onPreview={setAiPreview} />,
          }}
        />
      </main>
      <Splitter axis="y" sign={-1} value={layout.timelineHeight} onChange={(v) => setLayout("timelineHeight", v)} onReset={() => resetLayout("timelineHeight")} testId="split-timeline" title="Drag to resize the timeline" />
      <Timeline headerWidth={layout.headerWidth} thumbs={thumbs}
        headerSplitter={<Splitter axis="x" sign={1} value={layout.headerWidth} onChange={(v) => setLayout("headerWidth", v)} onReset={() => resetLayout("headerWidth")} testId="split-header" title="Drag to resize the track headers" />}
        state={state} dispatch={dispatch} captions={captions} library={library} zoomEdit={zoomEdit} onZoomEdit={setZoomEdit} onRangeAction={(kind) => (kind === "effect" ? openTab("vibe") : createZoom())} />
      <footer className="status-bar">
        Space play · J / K / L reverse / stop / forward · Click to select · Delete ripple delete · Ctrl+B split at playhead · Ctrl+Z / Ctrl+Shift+Z undo / redo · ← → frame · ↑ ↓ edit points · Ctrl+wheel zoom
      </footer>
    </div>
  );
}

export default App;
