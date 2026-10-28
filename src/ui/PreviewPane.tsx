import { useEffect, useMemo, useRef, type Dispatch, type ReactNode } from "react";
import { ensureAudioGraph } from "../audio/audioGraph";
import { duckingCurve } from "../audio/ducking";
import { timelineWords, type Caption } from "../core/captions";
import type { Project } from "../core/model";
import { EffectRenderer } from "../anim/effectRenderer";
import type { PluginService } from "../anim/pluginService";
import { PreviewPlayer } from "../compositor/previewPlayer";
import type { Engine } from "../engine/Engine";
import type { Library } from "./useMediaLibrary";
import { BoxOverlay } from "./BoxOverlay";
import { FPS, formatTimecode, type Action } from "./state";

/** 預覽畫布的解析度（顯示時由 CSS 縮放） */
const PREVIEW_WIDTH = 1280;
const PREVIEW_HEIGHT = 720;

/** 左側預覽（D33）：WebGL 合成器畫面＋字幕＋播放控制 */
export function PreviewPane(props: {
  project: Project;
  playhead: number;
  playing: boolean;
  rate: number;
  /** 每次開始播放遞增（先 seek 再 play 時用它重起播放迴圈） */
  playSeq: number;
  duration: number;
  captions: Caption[];
  engine: Engine;
  library: Library;
  plugins: PluginService;
  /** 選取中的特效（預覽上顯示它的目標框） */
  selectedEffectId: string | null;
  /** 疊在預覽上的調框層（局部放大的放大框；有它時不顯示特效的目標框） */
  overlay?: ReactNode;
  dispatch: Dispatch<Action>;
}) {
  const { project, playhead, playing, rate, playSeq, duration, captions, engine, library, plugins, selectedEffectId, overlay, dispatch } = props;
  const frameRef = useRef<HTMLDivElement>(null);
  // 有目標框的特效（2D 與疊加的 3D）才在預覽上顯示框
  const selectedEffect = project.effects.find((e) => e.id === selectedEffectId && (e.kind === "anim2d" || e.kind === "anim3d") && !!e.params.box);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<PreviewPlayer | null>(null);
  /** 播放迴圈要讀的最新值（避免每格重建迴圈） */
  const latest = useRef({ playhead, playing, rate });
  latest.current = { playhead, playing, rate };

  /** 2D 特效的畫格管理（沙盒） */
  const effectsRef = useRef<EffectRenderer | null>(null);

  // 建立播放器（每個畫布一次）；暫停時元素拖動完成、或特效畫格回來，就重畫目前這一格
  useEffect(() => {
    const redraw = () => {
      const { playhead: t, playing: p, rate: r } = latest.current;
      if (!p) requestAnimationFrame(() => playerRef.current?.render(latest.current.playhead ?? t, false, r));
    };
    const player = new PreviewPlayer(canvasRef.current!, (m) => engine.mediaUrl(m), redraw);
    const effects = new EffectRenderer(plugins.host, plugins.three, redraw);
    player.setEffectRenderer(effects, FPS);
    playerRef.current = player;
    effectsRef.current = effects;
    return () => { player.dispose(); effects.dispose(); playerRef.current = null; effectsRef.current = null; };
  }, [engine, plugins]);

  // 專案變了（編輯後）就交給播放器；新插件送進沙盒後再重畫
  useEffect(() => {
    playerRef.current?.setProject(project);
    const effects = effectsRef.current;
    if (!effects) return;
    effects.prune(project);
    void effects.syncPlugins(project.plugins).then(() => {
      if (!latest.current.playing) playerRef.current?.render(latest.current.playhead, false, latest.current.rate);
    });
  }, [project]);

  // 字幕交給播放器畫進合成畫面（詞的時間供逐字高亮）
  const captionWords = useMemo(() => timelineWords(project), [project]);
  useEffect(() => {
    playerRef.current?.setCaptions(captions, captionWords);
    if (!latest.current.playing) playerRef.current?.render(latest.current.playhead, false, latest.current.rate);
  }, [captions, captionWords]);

  /** 配樂壓低曲線：專案或音量包絡變了才重算（§5.13） */
  const duck = useMemo(() => duckingCurve(project, library.envelopes), [project, library.envelopes]);
  useEffect(() => { playerRef.current?.setDuckCurve(duck); }, [duck]);

  // 暫停時：播放頭或專案（含代理檔換好）變了就重畫
  useEffect(() => {
    if (!playing) playerRef.current?.render(playhead, false, rate);
  }, [playhead, project, playing, rate]);

  // 播放時：每個畫格依經過的時間推進播放頭（倍速、倒退都照 rate）
  useEffect(() => {
    if (!playing) return;
    const t0 = latest.current.playhead;
    const startedAt = performance.now();
    let frame = 0;
    const loop = (now: number) => {
      const t = t0 + ((now - startedAt) / 1000) * rate;
      playerRef.current?.render(t, true, rate);
      dispatch({ type: "tick", time: t });
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing, rate, playSeq, dispatch]);

  /** 播放頭所在的字幕（畫面上的字幕由合成器畫；這裡只放進 data-caption 給測試與輔助工具讀） */
  const caption = captions.find((c) => playhead >= c.start && playhead < c.end);
  return (
    <section className="preview">
      <div className="viewer">
        <div className="frame" ref={frameRef}>
          <canvas ref={canvasRef} width={PREVIEW_WIDTH} height={PREVIEW_HEIGHT} data-testid="preview-canvas" data-caption={caption?.lines.join(" ") ?? ""} />
          {selectedEffect && !playing && !overlay && <BoxOverlay effect={selectedEffect} frame={frameRef.current} dispatch={dispatch} />}
          {!playing && overlay}
        </div>
      </div>
      <div className="transport">
        <button title="Back one frame (←)" onClick={() => dispatch({ type: "seek", time: playhead - 1 / FPS })}>◀|</button>
        <button title="Reverse (J)" onClick={() => { ensureAudioGraph(); dispatch({ type: "play", rate: -1 }); }}>◀◀</button>
        <button title="Play / pause (Space)" data-testid="play" onClick={() => { ensureAudioGraph(); dispatch(playing ? { type: "pause" } : { type: "play", rate: 1 }); }}>{playing ? "❚❚" : "▶"}</button>
        <button title="Forward one frame (→)" onClick={() => dispatch({ type: "seek", time: playhead + 1 / FPS })}>|▶</button>
        <span className="timecode" data-testid="preview-timecode">{formatTimecode(playhead)}</span>
        {playing && rate !== 1 && <span className="muted">{rate > 0 ? `${rate}×` : `◀ ${-rate}×`}</span>}
        <span className="muted">Edited {formatTimecode(duration)}</span>
      </div>
    </section>
  );
}
