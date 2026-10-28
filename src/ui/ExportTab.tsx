// 匯出頁籤（spec §5.4）：選解析度 → 選存檔位置 → 逐格合成、編碼成 MP4（有進度、可取消），同時輸出 SRT。
import { beginBusy } from "../core/busy";
import { useMemo, useRef, useState } from "react";
import { createImageSource } from "../anim/effectImages";
import { EffectRenderer } from "../anim/effectRenderer";
import type { PluginService } from "../anim/pluginService";
import { duckingCurve } from "../audio/ducking";
import type { Envelope } from "../audio/envelope";
import { timelineWords, type Caption } from "../core/captions";
import type { Project } from "../core/model";
import type { Engine } from "../engine/Engine";
import { mixAudio } from "../export/audioMix";
import { ExportCancelled, runExport } from "../export/exporter";
import { exportPlan, type ExportPreset } from "../export/exportPlan";
import { toSrt } from "../export/srt";

/** 匯出狀態 */
type Status =
  | { kind: "idle" }
  | { kind: "running"; frame: number; total: number; startedAt: number }
  | { kind: "done"; message: string }
  | { kind: "error"; message: string };

/** 解析度選項的顯示文字 */
const PRESETS: { id: ExportPreset; label: string }[] = [
  { id: "source", label: "Match source" },
  { id: "1080p", label: "1080p" },
  { id: "720p", label: "720p" },
];

/** 匯出頁籤 */
export function ExportTab({ project, captions, engine, plugins, envelopes, suggestedName = "wordblade-export.mp4" }: {
  /** 存檔對話框預設的檔名或路徑（開著專案資料夾時是資料夾旁邊的 <專案名>.mp4） */
  suggestedName?: string;
  project: Project;
  captions: Caption[];
  engine: Engine;
  plugins: PluginService;
  /** 素材的音量包絡：算配樂壓低曲線（和預覽同一條） */
  envelopes: Map<string, Envelope>;
}) {
  const [preset, setPreset] = useState<ExportPreset>("source");
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  /** 取消用 */
  const abortRef = useRef<AbortController | null>(null);
  const plan = exportPlan(project, preset);
  const duck = useMemo(() => duckingCurve(project, envelopes), [project, envelopes]);

  /** 開始匯出 */
  const start = async () => {
    const target = await engine.openExportTarget(suggestedName);
    if (!target) return;
    const abort = new AbortController();
    abortRef.current = abort;
    const startedAt = performance.now();
    setStatus({ kind: "running", frame: 0, total: plan.frames, startedAt });
    /** 匯出是重工作：期間背景縮圖排程停下來（§5.21） */
    const endBusy = beginBusy();
    const images = createImageSource((m) => engine.mediaUrl(m), (id) => project.media.find((m) => m.id === id));
    const effects = new EffectRenderer(plugins.host, plugins.three, () => undefined, images);
    try {
      await effects.syncPlugins(project.plugins);
      const { canEncodeAudio } = await import("mediabunny");
      const audioCodec = (await canEncodeAudio("aac")) ? "aac" : "opus";
      const result = await runExport({
        project, plan, target, effects, audioCodec,
        source: (m) => engine.exportSource(m),
        audio: (audioSource, signal) => mixAudio({ project, duration: plan.duration, source: (m) => engine.exportSource(m), audioSource, duck, signal }),
        captions: { captions, words: timelineWords(project) },
        onProgress: (p) => setStatus({ kind: "running", frame: p.frame, total: p.total, startedAt }),
        signal: abort.signal,
      });
      const srt = captions.length ? await target.writeSibling("srt", toSrt(captions)) : null;
      const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
      const skipped = result.effectErrors.size ? ` · ${result.effectErrors.size} effect(s) skipped: ${[...result.effectErrors.values()][0]}` : "";
      setStatus({ kind: "done", message: `Saved ${target.name} in ${seconds} s${srt ? ` · subtitles: ${srt}` : ""}${skipped}` });
    } catch (e) {
      setStatus(e instanceof ExportCancelled ? { kind: "idle" } : { kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      abortRef.current = null;
      images.dispose();
      endBusy();
    }
  };

  const running = status.kind === "running";
  return (
    <div className="export-tab">
      <label className="param-field">
        <span>Resolution</span>
        <select data-testid="export-preset" value={preset} disabled={running} onChange={(e) => setPreset(e.target.value as ExportPreset)}>
          {PRESETS.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
      </label>
      <p className="muted" data-testid="export-summary">
        {plan.width}×{plan.height} · {plan.fps} fps · {plan.duration.toFixed(1)} s · H.264 {(plan.videoBitrate / 1e6).toFixed(1)} Mbps
      </p>
      {running ? (
        <>
          <progress data-testid="export-progress" max={status.total} value={status.frame} />
          <p className="muted">{status.frame} / {status.total} frames</p>
          <button type="button" data-testid="export-cancel" onClick={() => abortRef.current?.abort()}>Cancel</button>
        </>
      ) : (
        <button type="button" data-testid="export-start" disabled={plan.frames === 0} onClick={() => void start()}>Export MP4</button>
      )}
      {status.kind === "done" && <p data-testid="export-status">{status.message}</p>}
      {status.kind === "error" && <p className="error" data-testid="export-error">{status.message}</p>}
    </div>
  );
}
