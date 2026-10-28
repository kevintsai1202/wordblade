// AI 導演的一次執行（spec §5.11）：依停頓切段 → 每段轉 480p、每秒 2 格、無聲的小檔（呼叫端注入）＋那段的詞 → 建工作、逐段上傳
// （上傳後閘道在背景分析，這邊接著轉下一段）→ 輪詢到完成 → 建議（補上 id、素材、狀態，前端再檢查一次）。
import type { Media, Suggestion, Word } from "../core/model";
import type { DirectorView, SegmentMeta } from "./api";
import { planSegments } from "./segments";
import { clampSuggestions } from "./suggestions";

/** 每格大約多少 prompt tokens（Muse Spark，480p、每秒 2 格；2026-10-27／28 實測約 130） */
export const TOKENS_PER_FRAME = 130;

/** 估計要用多少 tokens（Spark 看影片＋Wonder 統籌約 1 成） */
export function estimateTokens(duration: number): number {
  return Math.round(duration * 2 * TOKENS_PER_FRAME * 1.1);
}

/** 進度 */
export interface DirectorProgress {
  /** converting（轉第 n 段）、analysing（閘道逐段分析，done／total）、planning（統籌） */
  stage: "converting" | "analysing" | "planning";
  done: number;
  total: number;
}

/** 失敗代碼 → 給使用者看的訊息 */
const ERRORS: Record<string, string> = {
  "segments-failed": "The AI couldn't analyse any part of this video. Try again.",
  "plan-failed": "The AI couldn't put the suggestions together. Try again.",
};

/** 執行參數 */
export interface DirectorRunOptions {
  media: Media;
  /** 這支素材的詞（素材時間） */
  words: Word[];
  /** 3D 場景（運鏡建議只能用這些） */
  scenes: { id: string; name: string }[];
  /** 素材 [s, e) → 480p、每秒 2 格、無聲的 MP4 */
  makeClip: (s: number, e: number) => Promise<Uint8Array>;
  api: {
    start(body: { mediaName: string; duration: number; segments: number; scenes: { id: string; name: string }[] }): Promise<string>;
    upload(jobId: string, index: number, meta: SegmentMeta, video: Uint8Array): Promise<void>;
    poll(jobId: string): Promise<DirectorView>;
    cancel(jobId: string): Promise<void>;
  };
  onProgress?: (p: DirectorProgress) => void;
  signal?: AbortSignal;
  pollMs?: number;
}

/** 已取消 */
const aborted = () => new DOMException("Cancelled", "AbortError");

/** 執行一次 AI 導演；回傳建議（狀態 pending） */
export async function runDirector(opts: DirectorRunOptions): Promise<Suggestion[]> {
  const { media } = opts;
  const words = opts.words.filter((w) => w.mediaId === media.id).sort((a, b) => a.start - b.start);
  const segments = planSegments(words, media.duration);
  const jobId = await opts.api.start({ mediaName: media.name ?? media.id, duration: media.duration, segments: segments.length, scenes: opts.scenes });
  const stop = async () => {
    await opts.api.cancel(jobId).catch(() => undefined);
    throw aborted();
  };
  for (const [i, seg] of segments.entries()) {
    if (opts.signal?.aborted) await stop();
    opts.onProgress?.({ stage: "converting", done: i, total: segments.length });
    const video = await opts.makeClip(seg.start, seg.end);
    if (opts.signal?.aborted) await stop();
    const segWords = words.filter((w) => w.start >= seg.start && w.start < seg.end).map((w) => ({ id: w.id, t: Math.round(w.start * 100) / 100, text: w.text }));
    await opts.api.upload(jobId, i, { start: seg.start, end: seg.end, words: segWords }, video);
  }
  for (;;) {
    if (opts.signal?.aborted) await stop();
    const view = await opts.api.poll(jobId);
    if (view.status === "done") {
      const list: Suggestion[] = view.suggestions.map((s, n) => ({ ...s, id: `sug-${media.id}-${Date.now().toString(36)}-${n}`, mediaId: media.id, status: "pending" }));
      return clampSuggestions(list, { duration: media.duration, scenes: new Set(opts.scenes.map((s) => s.id)), wordIds: new Set(words.map((w) => w.id)) });
    }
    if (view.status === "failed") throw new Error(ERRORS[view.error ?? ""] ?? "The AI director failed. Try again.");
    if (view.status === "cancelled") throw aborted();
    opts.onProgress?.(view.status === "planning" ? { stage: "planning", done: view.segmentsDone, total: view.segmentsTotal } : { stage: "analysing", done: view.segmentsDone + view.segmentsFailed, total: view.segmentsTotal });
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 2000));
  }
}
