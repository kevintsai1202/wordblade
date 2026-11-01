// AI 導演的一次執行（spec §5.11；docs/plan-10-29-director2.md）：
// 依停頓切段 → 先算全部的畫面變化區、拼一張規劃用的畫面總表（最後一段上傳前送，規劃者看得到畫面）→ 每段轉 480p、每秒 2 格、無聲的小檔、連同那段的詞上傳（閘道 Spark 逐段理解）→ 規劃者寫剪輯腳本（planned）
// → 依各項開頭的畫面拼一張縮圖總表送審（審查者獨立判定，有退回就改一輪）→ 剪輯腳本＋章節。
// 前端補上素材、狀態與 id 前綴；審查刪掉的狀態是略過；放大項目若指向活動區，帶上跟著變化走的路徑。各步驟由呼叫端注入（測試換成假的）。
import type { DirectorChapter, Media, Suggestion, Word } from "../core/model";
import { zoomFromActivity, type Activity } from "./activity";
import type { DirectorStyle, DirectorSuggestion, DirectorTreatment, DirectorView, SegmentMeta } from "./api";
import { planSegments } from "./segments";
import { clampSuggestions } from "./suggestions";

/** 每格大約多少 prompt tokens（Muse Spark，480p、每秒 2 格；2026-10-27／28 實測約 130） */
export const TOKENS_PER_FRAME = 130;

/** 兩張畫面總表（規劃用＋審查用，各最多 32 格）大約多少 prompt tokens */
const SHEET_TOKENS = 2 * 3000;

/** 估計要用多少 tokens（Spark 看影片＋Wonder 規劃與審查約 2 成＋兩張畫面總表） */
export function estimateTokens(duration: number): number {
  return Math.round(duration * 2 * TOKENS_PER_FRAME * 1.2) + SHEET_TOKENS;
}

/** 進度 */
export interface DirectorProgress {
  /** converting（轉第 n 段）、analysing（閘道逐段理解，done／total）、planning（規劃）、reviewing（審查） */
  stage: "converting" | "analysing" | "planning" | "reviewing";
  done: number;
  total: number;
}

/** 失敗代碼 → 給使用者看的訊息 */
const ERRORS: Record<string, string> = {
  "segments-failed": "The AI couldn't analyse any part of this video. Try again.",
  "plan-failed": "The AI couldn't put the edit plan together. Try again.",
};

/** 執行參數 */
export interface DirectorRunOptions {
  media: Media;
  /** 這支素材的詞（素材時間） */
  words: Word[];
  /** 3D 場景（轉場只能用這些） */
  scenes: { id: string; name: string }[];
  /** 素材 [s, e) → 480p、每秒 2 格、無聲的 MP4 */
  makeClip: (s: number, e: number) => Promise<Uint8Array>;
  /** 素材 [s, e) 的畫面變化區（比對縮圖）；不給就不送活動區 */
  activities?: (s: number, e: number) => Promise<Activity[]>;
  /** 依各項開頭的畫面拼縮圖總表；不給就只送文字給審查者 */
  contactSheet?: (items: DirectorSuggestion[]) => Promise<Blob | null>;
  /** 依 planFrames 的格子拼規劃用的畫面總表；不給就只送文字給規劃者 */
  planSheet?: (cells: FrameCell[]) => Promise<Blob | null>;
  /** 風格（決定導演能用哪些種類；預設 plain） */
  style?: DirectorStyle;
  /** 使用者的導演指示（一條一句；空的不送） */
  directives?: string[];
  api: {
    start(body: { mediaName: string; duration: number; segments: number; scenes: { id: string; name: string }[]; style?: DirectorStyle; directives?: string[] }): Promise<string>;
    frames(jobId: string, sheet: Blob): Promise<void>;
    upload(jobId: string, index: number, meta: SegmentMeta, video: Uint8Array): Promise<void>;
    review(jobId: string, sheet: Blob | null): Promise<void>;
    poll(jobId: string): Promise<DirectorView>;
    cancel(jobId: string): Promise<void>;
  };
  onProgress?: (p: DirectorProgress) => void;
  signal?: AbortSignal;
  pollMs?: number;
}

/** 執行結果：剪輯腳本（含審查刪掉的，狀態是略過）、章節與導演構想 */
export interface DirectorResult {
  suggestions: Suggestion[];
  chapters: DirectorChapter[];
  treatment: DirectorTreatment | null;
}

/** 畫面總表的一格：標籤（活動區 id 或「t=秒數s」）與素材時間 */
export interface FrameCell {
  label: string;
  t: number;
}

/** 規劃用畫面總表最多幾格（和審查用的總表一樣） */
const PLAN_CELLS = 32;
/** 沒有活動區的地方每隔幾秒取一格 */
const PLAN_EVERY = 15;

/**
 * 規劃者要看的畫面：每個畫面變化區取中間一格（標活動區 id，讓規劃者對得上放大要用的 id），
 * 再每 15 秒取一格（標秒數，代替還不知道的章節開頭）；超過 32 格時活動區優先、時間格平均抽，依時間排序。
 */
export function planFrames(activities: Activity[], duration: number): FrameCell[] {
  const acts = activities.slice(0, PLAN_CELLS).map((a) => ({ label: a.id, t: Math.round(((a.start + a.end) / 2) * 10) / 10 }));
  let times: FrameCell[] = [];
  for (let t = 0; t < duration; t += PLAN_EVERY) times.push({ label: `t=${Math.round(t)}s`, t: Math.min(duration - 0.1, t + 0.5) });
  const room = PLAN_CELLS - acts.length;
  if (times.length > room) times = Array.from({ length: Math.max(0, room) }, (_, i) => times[Math.floor((i * times.length) / room)]);
  return [...acts, ...times].sort((a, b) => a.t - b.t);
}

/** 已取消 */
const aborted = () => new DOMException("Cancelled", "AbortError");

/** 執行一次 AI 導演 */
export async function runDirector(opts: DirectorRunOptions): Promise<DirectorResult> {
  const { media } = opts;
  const words = opts.words.filter((w) => w.mediaId === media.id).sort((a, b) => a.start - b.start);
  const segments = planSegments(words, media.duration);
  const jobId = await opts.api.start({ mediaName: media.name ?? media.id, duration: media.duration, segments: segments.length, scenes: opts.scenes, style: opts.style ?? "plain", directives: (opts.directives ?? []).map((d) => d.trim()).filter(Boolean) });
  const stop = async () => {
    await opts.api.cancel(jobId).catch(() => undefined);
    throw aborted();
  };
  /** 送出去的活動區（放大項目用 id 找回路徑） */
  const activities = new Map<string, Activity>();
  // 先算全部段落的畫面變化區（比對縮圖，很快），拼規劃用的總表；送不出去就只送文字
  const segActs: Activity[][] = [];
  for (const seg of segments) {
    const acts = opts.activities ? await opts.activities(seg.start, seg.end) : [];
    for (const a of acts) activities.set(a.id, a);
    segActs.push(acts);
  }
  if (opts.planSheet) {
    const sheet = await opts.planSheet(planFrames([...activities.values()], media.duration)).catch(() => null);
    if (sheet) await opts.api.frames(jobId, sheet).catch(() => undefined);
  }
  for (const [i, seg] of segments.entries()) {
    if (opts.signal?.aborted) await stop();
    opts.onProgress?.({ stage: "converting", done: i, total: segments.length });
    const acts = segActs[i];
    const video = await opts.makeClip(seg.start, seg.end);
    if (opts.signal?.aborted) await stop();
    const segWords = words.filter((w) => w.start >= seg.start && w.start < seg.end).map((w) => ({ id: w.id, t: Math.round(w.start * 100) / 100, text: w.text }));
    await opts.api.upload(jobId, i, {
      start: seg.start, end: seg.end, words: segWords,
      activities: acts.map(({ id, start, end, x, y, w, h }) => ({ id, start, end, x, y, w, h })),
    }, video);
  }
  let reviewSent = false;
  for (;;) {
    if (opts.signal?.aborted) await stop();
    const view = await opts.api.poll(jobId);
    if (view.status === "planned" && !reviewSent) {
      reviewSent = true;
      opts.onProgress?.({ stage: "reviewing", done: 0, total: 1 });
      const sheet = opts.contactSheet ? await opts.contactSheet(view.suggestions).catch(() => null) : null;
      await opts.api.review(jobId, sheet);
    } else if (view.status === "done") {
      return toResult(view, media, words, opts.scenes, activities);
    } else if (view.status === "failed") {
      throw new Error(ERRORS[view.error ?? ""] ?? "The AI director failed. Try again.");
    } else if (view.status === "cancelled") {
      throw aborted();
    } else {
      opts.onProgress?.(view.status === "planning" ? { stage: "planning", done: view.segmentsDone, total: view.segmentsTotal }
        : view.status === "reviewing" || view.status === "planned" ? { stage: "reviewing", done: 0, total: 1 }
          : { stage: "analysing", done: view.segmentsDone + view.segmentsFailed, total: view.segmentsTotal });
    }
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 2000));
  }
}

/** 閘道的結果 → 專案的建議與章節 */
function toResult(view: DirectorView, media: Media, words: Word[], scenes: { id: string }[], activities: Map<string, Activity>): DirectorResult {
  const stamp = Date.now().toString(36);
  const convert = (s: DirectorSuggestion, status: Suggestion["status"]): Suggestion => {
    const payload = { ...s.payload };
    // 放大指向活動區：帶上跟著變化走的框寬與路徑（只留這一項時間內的點）
    const act = s.kind === "zoom" && typeof payload.activity === "string" ? activities.get(payload.activity) : undefined;
    if (act) {
      const z = zoomFromActivity(act);
      const inside = z.path.filter((p) => p.src >= s.start && p.src <= s.end);
      Object.assign(payload, { w: z.w, cx: z.path[0].cx, cy: z.path[0].cy, path: inside.length ? inside : [{ ...z.path[0], src: s.start }] });
    }
    return {
      id: `sug-${media.id}-${stamp}-${s.id}`, mediaId: media.id, kind: s.kind, start: s.start, end: s.end, payload, reason: s.purpose || s.reason,
      status, purpose: s.purpose, quote: s.quote, chapter: s.chapter, review: s.review ?? undefined, problem: s.problem ?? undefined,
    };
  };
  const kept = clampSuggestions(view.suggestions.map((s) => convert(s, "pending")), { duration: media.duration, scenes: new Set(scenes.map((s) => s.id)), wordIds: new Set(words.map((w) => w.id)) });
  const removed = (view.removed ?? []).map((s) => convert(s, "skipped"));
  return {
    suggestions: [...kept, ...removed].sort((a, b) => a.start - b.start),
    chapters: (view.chapters ?? []).map((c) => ({ mediaId: media.id, title: c.title, start: c.start, end: c.end })),
    treatment: view.treatment ?? null,
  };
}
