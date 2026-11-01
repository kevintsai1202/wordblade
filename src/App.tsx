import { useEffect, useMemo, useReducer, useRef, useState, type CSSProperties } from "react";
import { ensureAudioGraph } from "./audio/audioGraph";
import { buildCaptions } from "./core/captions";
import { emptyProject } from "./core/media";
import { setEffectParams } from "./core/effects";
import { PluginService } from "./anim/pluginService";
import { createEngine } from "./engine/createEngine";
import { demoProject } from "./ui/demoProject";
import { loadSample, samplePath } from "./project/sample";
import { EditPanel } from "./ui/EditPanel";
import { MediaTab } from "./ui/MediaTab";
import { PreviewPane } from "./ui/PreviewPane";
import { WelcomePanel } from "./ui/WelcomePanel";
import { commonFolder } from "./engine/rootPath";
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
import { MaskTab } from "./ui/MaskTab";
import { DirectorTab } from "./ui/DirectorTab";
import { IntroTab } from "./ui/IntroTab";
import { PublishTab, type Thumbnail } from "./ui/PublishTab";
import { SoundTab } from "./ui/SoundTab";
import { TextureTab } from "./ui/TextureTab";
import { ZoomEditOverlay } from "./ui/ZoomEditOverlay";
import type { ZoomEdit } from "./ui/ZoomBands";
import { zoomFromRange } from "./core/zoom";
import { clipEnd, timelineToSource } from "./core/timeline";
import { useLayout } from "./ui/layout";
import { useProjectFolder } from "./ui/useProjectFolder";
import { exportPathFor } from "./project/session";
import { SESSION_KEY, restoreSession, serializeSession, shouldSave } from "./core/session";
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
  /** 最新的專案（開發用匯出鉤子讀） */
  const latestProject = useRef(project);
  latestProject.current = project;
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
  /** 發佈包的縮圖（只在記憶體；匯出時寫在影片旁邊） */
  const [thumbnail, setThumbnail] = useState<Thumbnail | null>(null);
  /** 最新的縮圖（開發用匯出鉤子讀） */
  const thumbRef = useRef(thumbnail);
  thumbRef.current = thumbnail;
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

  /** 目前是不是剛載入、還沒編輯過的示範專案（不自動存，免得蓋掉上次的工作） */
  const [isDemo, setIsDemo] = useState(START_WITH_DEMO);
  /** 上次的工作（開啟時讀一次；使用者按還原才載入，不自動還原） */
  const [lastSession, setLastSession] = useState(() => {
    if (START_WITH_DEMO) return null;
    try {
      return restoreSession(localStorage.getItem(SESSION_KEY));
    } catch {
      return null;
    }
  });
  /** 專案資料夾（D41；桌面版，網頁版之後接 File System Access） */
  const folder = useProjectFolder({ engine, project, edits: state.history.past.length, isDemo, dispatch, reset, enqueuePrepare });
  /** 另存時輸入的專案名稱（null 表示沒在輸入） */
  const [saveName, setSaveName] = useState<string | null>(null);
  // 瀏覽器裡的自動存檔：沒開專案資料夾時才用（開了就存進 project.json）；使用者編輯後 2 秒存；太大存不下就暫停並提示
  useEffect(() => {
    if (folder.location || !shouldSave(project, state.history.past.length, isDemo)) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(SESSION_KEY, serializeSession(project, Date.now()));
      } catch {
        setNotice("Autosave paused — this project is too large to keep in the browser.");
      }
    }, 2000);
    return () => clearTimeout(timer);
  }, [project, state.history.past.length, isDemo, folder.location]);
  // 啟動時自動開最後一個專案（2026-11-01 開發者決定）：桌面版直接開；網頁版要使用者點一下才拿得到檔案權限，交給歡迎畫面的 Continue。
  // 開不了（搬走、刪掉）就留在歡迎畫面並提示
  const autoOpened = useRef(false);
  useEffect(() => {
    if (autoOpened.current || START_WITH_DEMO || engine.kind !== "desktop" || !engine.projectFolders) return;
    autoOpened.current = true;
    const last = folder.recent[0];
    if (last) void folder.reopen(last).then((err) => err && setNotice(err));
  }, [engine, folder]);
  /** 還沒開專案、專案也完全是空的（沒有素材、片段、特效）：預覽區顯示歡迎畫面；一動手就讓開 */
  const showWelcome = !folder.location && !isDemo && project.media.length === 0 && project.clips.length === 0 && project.effects.length === 0;

  /** 還原上次的工作：載入專案、素材照常在背景準備（桌面版路徑還在；網頁版要重新匯入檔案） */
  const restoreLast = () => {
    if (!lastSession) return;
    reset(project.media);
    dispatch({ type: "load", project: lastSession.project });
    for (const m of lastSession.project.media) enqueuePrepare(m);
    setIsDemo(false);
    setLastSession(null);
    if (engine.kind === "web") setNotice("Restored. On the web, import the video files again to see them.");
  };

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
   * 開範例專案（§5.22）：預先算好的 2 分鐘範例（逐字稿、AI 結果、特效都在裡面），不用權杖、不呼叫 AI。
   * 和示範專案一樣是「示範狀態」：沒編輯前不自動存，不蓋掉上次的工作。
   */
  const onLoadSample = async () => {
    const opened = await engine.openSample();
    const sample = opened && loadSample(opened.text, opened.root);
    if (!sample) {
      setNotice("The sample project isn't available here.");
      return;
    }
    setNotice(null);
    setIsDemo(true);
    setLastSession(null);
    reset(project.media);
    dispatch({ type: "load", project: sample });
    for (const m of sample.media) enqueuePrepare(m);
    // 發佈包的縮圖不在專案裡：範例資料夾有 thumbnail.png 就一起載入（匯出時寫在影片旁邊）
    const thumbUrl = engine.mediaUrl({ id: "sample-thumbnail", kind: "image", duration: 0, path: samplePath("sample/thumbnail.png", opened.root) });
    const res = await fetch(thumbUrl).catch(() => null);
    if (res?.ok) {
      const blob = await res.blob();
      setThumbnail({ blob, url: URL.createObjectURL(blob) });
    }
  };

  // 網址帶 ?sample=1 就直接開範例專案（e2e 與分享連結用）
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("sample")) void onLoadSample();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // 開發用（範例專案打包腳本 e2e/sample-build.spec.ts）：localStorage wordblade.dev＝1 時提供目前的專案與素材檔的位元組
  useEffect(() => {
    let dev = false;
    try {
      dev = localStorage.getItem("wordblade.dev") === "1";
    } catch { /* 沒有 localStorage 就不開 */ }
    if (!dev) return;
    (window as unknown as { __wordblade?: unknown }).__wordblade = {
      project: () => latestProject.current,
      dispatch,
      thumbnail: async () => (thumbRef.current ? Array.from(new Uint8Array(await thumbRef.current.blob.arrayBuffer())) : null),
      fileBytes: (handleKey: string) => (engine as unknown as { fileBytes?: (k: string) => Promise<Uint8Array | null> }).fileBytes?.(handleKey) ?? Promise.resolve(null),
    };
  }, [engine, dispatch]);

  /** 開選檔對話框並匯入 */
  const onImport = async () => importSources(await engine.pickFiles());

  return (
    <div className="app" style={{ "--panel-w": `${layout.panelWidth}px`, "--timeline-h": `${layout.timelineHeight}px` } as CSSProperties}>
      <header className="title-bar">
        <span className="brand">WordBlade</span>
        <span className="project-path" data-testid="project-name" title={folder.location?.dir}>{folder.location ? folder.location.name : project.media.length ? "untitled project" : "new project"}</span>
        {folder.status && <span className="muted" data-testid="save-status">{folder.status.kind === "saving" ? "Saving…" : folder.status.kind === "error" ? `Not saved: ${folder.status.message}` : `Saved ${new Date(folder.status.at ?? 0).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`}</span>}
        {engine.projectFolders && (
          <>
            {saveName === null
              ? <button data-testid="project-save-as" title="Save this project as a .wordblade folder" onClick={() => setSaveName(folder.location?.name ?? project.media[0]?.name?.replace(/\.[^.]+$/, "") ?? "Untitled")}>{folder.location ? "Save as…" : "New project…"}</button>
              : (
                <form className="save-as" onSubmit={(e) => { e.preventDefault(); const n = saveName.trim(); setSaveName(null); if (n) void folder.saveAs(n); }}>
                  <input autoFocus data-testid="project-name-input" value={saveName} maxLength={80} onChange={(e) => setSaveName(e.target.value)} />
                  <button type="submit">Choose folder…</button>
                  <button type="button" onClick={() => setSaveName(null)}>✕</button>
                </form>
              )}
            <button data-testid="project-open" title="Open a .wordblade project folder" onClick={() => void folder.open().then((err) => err && setNotice(err))}>Open…</button>
            {folder.recent.length > 0 && (
              <select data-testid="project-recent" value="" title="Recent projects" onChange={(e) => { const r = folder.recent.find((x) => x.dir === e.target.value); if (r) void folder.reopen(r).then((err) => err && setNotice(err)); }}>
                <option value="">Recent…</option>
                {folder.recent.map((r) => <option key={r.dir} value={r.dir}>{r.name}</option>)}
              </select>
            )}
          </>
        )}
        {folder.missing.length > 0 && (
          <span className="warning" data-testid="missing-media" title={folder.missing.map((m) => m.name).join(", ")}>
            {folder.missing.length} media file{folder.missing.length > 1 ? "s" : ""} not found: {folder.missing.slice(0, 2).map((m) => m.name).join(", ")}{folder.missing.length > 2 ? "…" : ""}
            {/* 一次連一支（從第一支開始）；同資料夾裡的其他支會一起找回 */}
            {engine.kind === "web" && (() => {
              const paths = folder.missing.map((x) => project.media.find((m) => m.id === x.id)?.path).filter((p): p is string => !!p);
              const where = commonFolder(paths);
              return paths.length > 0 && (
                <button data-testid="allow-media-folder" className="primary" title="The browser can only read folders you allow. Allow once and WordBlade remembers it."
                  onClick={() => void folder.allowFolder().then((err) => err && setNotice(err))}>
                  Allow access to {where ?? "the media folder"}…
                </button>
              );
            })()}
            <button data-testid="relink-media" title={`Locate ${folder.missing[0].name}; others in the same folder are found automatically`} onClick={() => void folder.relink(folder.missing[0].id).then((err) => err && setNotice(err))}>Locate {folder.missing[0].name}…</button>
            <button onClick={folder.dismissMissing}>✕</button>
          </span>
        )}
        <button title="Open a ready-made 2-minute sample: transcript, AI suggestions and effects are already in it (no token needed)" data-testid="load-sample" onClick={() => void onLoadSample()}>Try the sample project</button>
        {lastSession && !project.media.length && (
          <span className="restore-bar" data-testid="restore-bar">
            Last session: {lastSession.project.clips.length} clips, saved {new Date(lastSession.savedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            <button data-testid="restore-session" onClick={restoreLast}>Restore</button>
            <button title="Keep it for later" onClick={() => setLastSession(null)}>✕</button>
          </span>
        )}
        {notice && <span className="muted" data-testid="notice">{notice}</span>}
        <span className="spacer" />
        <span className="muted" data-testid="engine-kind">Engine: {engine.kind}</span>
        <button disabled title="Export — coming soon">Export</button>
      </header>
      <main className="workspace">
        <PreviewPane
          cover={showWelcome ? (
            <WelcomePanel recent={folder.recent} projectFolders={engine.projectFolders}
              onNew={(n) => void folder.saveAs(n)}
              onOpen={() => void folder.open().then((err) => err && setNotice(err))}
              onReopen={(r) => void folder.reopen(r).then((err) => err && setNotice(err))}
              onSample={() => void onLoadSample()}
              lastSession={lastSession ? { clips: lastSession.project.clips.length, savedAt: lastSession.savedAt } : null}
              onRestore={restoreLast} />
          ) : undefined}
          project={shownProject} playhead={state.playhead} playing={state.playing} rate={state.rate} playSeq={state.playSeq} duration={projectDuration(project)} captions={captions} engine={engine} library={library} plugins={plugins} thumbs={thumbs} selectedEffectId={state.selectedEffectId}
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
            vibe3d: <VibeTab dimension="3d" plugins={plugins} playhead={state.playhead} range={state.range} dispatch={dispatch} engine={engine} importSources={importSources} />,
            transcript: <TranscriptTab project={project} captions={captions} playhead={state.playhead} dispatch={dispatch} />,
            transcriptTools: <><TranscribePanel project={project} engine={engine} envelopes={library.envelopes} dispatch={dispatch} /><CleanupPanel project={project} envelopes={library.envelopes} dispatch={dispatch} /></>,
            director: <DirectorTab project={project} engine={engine} envelopes={library.envelopes} plugins={plugins} playhead={state.playhead} importSources={importSources} dispatch={dispatch} />,
            mask: <MaskTab project={project} engine={engine} range={state.range} playhead={state.playhead} dispatch={dispatch} />,
            zoom: <ZoomTab project={project} edit={zoomEdit} onEdit={setZoomEdit} dispatch={dispatch} />,
            audio: <SoundTab engine={engine} project={project} playhead={state.playhead} range={state.range} importSources={importSources} dispatch={dispatch} />,
            textures: <TextureTab project={project} engine={engine} importSources={importSources} dispatch={dispatch} />,
            intro: <IntroTab project={project} engine={engine} importSources={importSources} dispatch={dispatch} />,
            style: <CaptionStyleTab project={project} dispatch={dispatch} />,
            export: <ExportTab suggestedName={exportPathFor(folder.location, "mp4")} project={project} captions={captions} engine={engine} plugins={plugins} envelopes={library.envelopes} thumbnail={thumbnail?.blob ?? null} />,
            publish: <PublishTab project={project} duration={projectDuration(project)} dispatch={dispatch} thumbnail={thumbnail} onThumbnail={setThumbnail} />,
            inspector: <InspectorTab project={project} effectId={state.selectedEffectId} clipId={state.selectedClipId} playhead={state.playhead} dispatch={dispatch} preview={aiPreview} onPreview={setAiPreview} onOpenTab={openTab} />,
          }}
        />
      </main>
      <Splitter axis="y" sign={-1} value={layout.timelineHeight} onChange={(v) => setLayout("timelineHeight", v)} onReset={() => resetLayout("timelineHeight")} testId="split-timeline" title="Drag to resize the timeline" />
      <Timeline headerWidth={layout.headerWidth} thumbs={thumbs}
        headerSplitter={<Splitter axis="x" sign={1} value={layout.headerWidth} onChange={(v) => setLayout("headerWidth", v)} onReset={() => resetLayout("headerWidth")} testId="split-header" title="Drag to resize the track headers" />}
        state={state} dispatch={dispatch} captions={captions} library={library} zoomEdit={zoomEdit} onZoomEdit={setZoomEdit} onRangeAction={(kind) => (kind === "effect" ? openTab("vibe") : kind === "mask" ? openTab("mask") : createZoom())} />
      <footer className="status-bar">
        Space play · J / K / L reverse / stop / forward · Click to select · Delete ripple delete · Ctrl+B split at playhead · Ctrl+Z / Ctrl+Shift+Z undo / redo · ← → frame · ↑ ↓ edit points · Ctrl+wheel zoom
      </footer>
    </div>
  );
}

export default App;
