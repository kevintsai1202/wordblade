// 逐字稿頁籤上方的轉錄工具（spec §5.2）：每支有聲素材一顆「Transcribe」，送 Muse ASR、重建詞級時間後寫進專案（一筆可復原的編輯）。
// 完整的逐字稿面板（改字即剪等）11/1 做；這裡只放按鈕、進度、結果與漏段提醒。
import { useState, type Dispatch } from "react";
import { GatewayClient, loadSettings } from "../ai/gateway";
import { transcribeMedia } from "../asr/transcribe";
import type { Envelope } from "../audio/envelope";
import type { Media, Project } from "../core/model";
import type { Engine } from "../engine/Engine";
import type { Action } from "./state";

/** 同意說明的鍵（同意過就不再問） */
const CONSENT_KEY = "wordblade.consent.asr";

/** 涵蓋率低於這個值就提醒可能漏段 */
const LOW_COVERAGE = 0.9;

/** 每段最長幾秒：預設由 transcribeMedia 決定；實測時可用 localStorage `wordblade.asr.maxSegment` 改 */
function maxSegment(): number | undefined {
  try {
    const v = Number(localStorage.getItem("wordblade.asr.maxSegment"));
    return v > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

/** 讀同意狀態 */
function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "yes";
  } catch {
    return false;
  }
}

/** 某支素材的轉錄狀態 */
type Job =
  | { kind: "running"; done: number; total: number }
  | { kind: "done"; message: string; warning: string | null }
  | { kind: "error"; message: string };

/** 轉錄工具 */
export function TranscribePanel({ project, engine, envelopes, dispatch }: { project: Project; engine: Engine; envelopes: Map<string, Envelope>; dispatch: Dispatch<Action> }) {
  const [jobs, setJobs] = useState<Record<string, Job>>({});
  /** 等使用者同意的素材 */
  const [asking, setAsking] = useState<Media | null>(null);
  const audible = project.media.filter((m) => m.kind !== "image" && m.audio !== false);
  const token = loadSettings().token;

  /** 轉錄一支素材 */
  const run = async (media: Media) => {
    const env = envelopes.get(media.id);
    const set = (job: Job) => setJobs((j) => ({ ...j, [media.id]: job }));
    if (!env) {
      set({ kind: "error", message: "Still preparing this media — try again in a moment." });
      return;
    }
    const gateway = new GatewayClient(loadSettings());
    const started = performance.now();
    set({ kind: "running", done: 0, total: 1 });
    try {
      const result = await transcribeMedia(
        media, env,
        (m, s, e) => engine.extractAsrAudio(m, s, e),
        (wav) => gateway.transcribe(wav),
        (p) => set({ kind: "running", ...p }),
        { maxSegment: maxSegment() },
      );
      // 實測腳本（e2e/asr-live.spec.ts）讀 Muse 的原始 turns：只在 localStorage `wordblade.debug` 為 "1" 時放到 window
      try {
        if (localStorage.getItem("wordblade.debug") === "1") (window as unknown as { __wordbladeAsr?: unknown }).__wordbladeAsr = { mediaId: media.id, segments: result.segments, turns: result.turns };
      } catch { /* 沒有 localStorage 就略過 */ }
      dispatch({ type: "commit", edits: [{ kind: "setWords", mediaId: media.id, words: result.words }] });
      const seconds = ((performance.now() - started) / 1000).toFixed(1);
      set({
        kind: "done",
        message: `${result.words.length} words in ${seconds} s`,
        warning: result.coverage < LOW_COVERAGE ? `The transcript covers only ${Math.round(result.coverage * 100)}% of the speech — some parts may be missing.` : null,
      });
    } catch (e) {
      set({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  /** 按下按鈕：第一次先問同意 */
  const start = (media: Media) => {
    if (!hasConsent()) setAsking(media);
    else void run(media);
  };

  /** 同意後接著轉錄 */
  const accept = () => {
    try {
      localStorage.setItem(CONSENT_KEY, "yes");
    } catch {
      /* 存不了就只在這次有效 */
    }
    const media = asking!;
    setAsking(null);
    void run(media);
  };

  if (!audible.length) return null;
  return (
    <div className="transcribe-panel" data-testid="transcribe-panel">
      <ul className="transcribe-list">
        {audible.map((m) => {
          const job = jobs[m.id];
          const has = project.words.some((w) => w.mediaId === m.id);
          return (
            <li key={m.id} data-media-id={m.id}>
              <span className="media-name">{m.name ?? m.id}</span>
              {job?.kind === "running" ? (
                <span className="muted" data-testid="transcribe-progress">Transcribing… {job.done}/{job.total}</span>
              ) : (
                // 音量包絡還沒算好（素材還在準備）不能轉錄：切段與詞級時間都靠它
                <button type="button" data-testid="transcribe-start" disabled={!token || !envelopes.has(m.id)} onClick={() => start(m)}>
                  {!envelopes.has(m.id) ? "Preparing…" : has ? "Transcribe again" : "Transcribe"}
                </button>
              )}
              {job?.kind === "done" && <span className="muted" data-testid="transcribe-status">{job.message}</span>}
              {job?.kind === "done" && job.warning && <span className="warning" data-testid="transcribe-warning">{job.warning}</span>}
              {job?.kind === "error" && <span className="error" data-testid="transcribe-error">{job.message}</span>}
            </li>
          );
        })}
      </ul>
      {!token && <p className="muted">Set your invite token in Effects → 2D → AI settings to transcribe.</p>}
      {asking && (
        <div className="consent" data-testid="transcribe-consent">
          <p>The audio of “{asking.name ?? asking.id}” will be sent to the WordBlade AI service and Meta Muse (Voice Transcribe) to make the transcript.</p>
          <button onClick={accept}>Agree and continue</button> <button onClick={() => setAsking(null)}>Cancel</button>
        </div>
      )}
    </div>
  );
}
