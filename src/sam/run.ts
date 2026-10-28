// SAM 遮罩的一次執行（spec §5.3）：範圍分段（每段 ≤ 90 秒、相鄰重疊一格）→ 每段轉小檔、算換鏡頭 → 送閘道工作 → 輪詢逐格輸出並解析
// → 全部段落整理成遮罩物件（換鏡頭、消失、跳太遠就拆開；段與段用重疊那格的框接起來）。轉小檔與閘道由呼叫端注入（測試換成假的）。
import type { MaskObject } from "../core/model";
import type { SamClip } from "./clip";
import type { SamJobView } from "./api";
import { planChunks } from "./plan";
import { SamStream, type SamFrame } from "./stream";
import { cutsFromDiffs, linkPasses, toMaskObjects, type SamPass } from "./tracks";

/** 一次請求最多追蹤幾個物件（SAM 3.1 的上限；原專案重送最多 8 輪補齊，這裡只提示） */
const SAM_ID_CAP = 16;

/** 閘道失敗代碼 → 給使用者看的訊息 */
const ERRORS: Record<string, string> = {
  "sam-upload": "Uploading the clip to the masking service failed. Try again.",
  "sam-upstream": "The masking service returned an error. Try again.",
};

/** 進度 */
export interface SamProgress {
  /** 第幾段（從 1 起）／共幾段 */
  chunk: number;
  chunks: number;
  stage: "preparing" | "tracking";
  /** 這一段已收到幾格 */
  frames: number;
}

/** 執行參數 */
export interface SamRunOptions {
  mediaId: string;
  /** 英文名詞片語 */
  prompt: string;
  /** 素材時間範圍 */
  start: number;
  end: number;
  /** 取樣率（每秒幾格） */
  fps: number;
  /** 素材 [s, e) → 小檔 */
  makeClip: (s: number, e: number) => Promise<SamClip>;
  api: { start(prompt: string, clip: Uint8Array): Promise<string>; poll(jobId: string, after: number): Promise<SamJobView>; cancel(jobId: string): Promise<void> };
  onProgress?: (p: SamProgress) => void;
  signal?: AbortSignal;
  /** 輪詢間隔（毫秒） */
  pollMs?: number;
}

/** 結果 */
export interface SamRunResult {
  objects: MaskObject[];
  /** 閘道回報的計費格數（各段加總） */
  billedFrames: number;
  /** 有一段的物件數到了 SAM 的上限（可能漏遮） */
  capped: boolean;
}

/** 已取消 */
const aborted = () => new DOMException("Cancelled", "AbortError");

/** 執行一次 SAM 遮罩 */
export async function runSam(opts: SamRunOptions): Promise<SamRunResult> {
  const chunks = planChunks(opts.start, opts.end, opts.fps);
  const passes: SamPass[] = [];
  let billedFrames = 0;
  let capped = false;
  for (const [i, chunk] of chunks.entries()) {
    if (opts.signal?.aborted) throw aborted();
    opts.onProgress?.({ chunk: i + 1, chunks: chunks.length, stage: "preparing", frames: 0 });
    const clip = await opts.makeClip(chunk.start, chunk.end);
    const jobId = await opts.api.start(opts.prompt, clip.bytes);
    const stream = new SamStream();
    const frames: SamFrame[] = [];
    let after = 0;
    for (;;) {
      if (opts.signal?.aborted) {
        await opts.api.cancel(jobId).catch(() => undefined);
        throw aborted();
      }
      const view = await opts.api.poll(jobId, after);
      after = view.next;
      for (const line of view.lines) frames.push(...stream.feed(`${line}\n`));
      opts.onProgress?.({ chunk: i + 1, chunks: chunks.length, stage: "tracking", frames: frames.length });
      if (view.status === "done") {
        frames.push(...stream.close());
        billedFrames += view.framesProcessed;
        break;
      }
      if (view.status === "failed") throw new Error(ERRORS[view.error ?? ""] ?? "Masking failed. Try again.");
      if (view.status === "cancelled") throw aborted();
      if (opts.signal?.aborted) continue;
      await new Promise((r) => setTimeout(r, opts.pollMs ?? 700));
    }
    if (new Set(frames.flatMap((f) => f.records.map((r) => r.id))).size >= SAM_ID_CAP) capped = true;
    passes.push({ start: chunk.start, fps: opts.fps, times: clip.times, clipW: clip.width, clipH: clip.height, frames, cuts: cutsFromDiffs(clip.diffs) });
  }
  const objects = toMaskObjects(linkPasses(passes), { mediaId: opts.mediaId, prompt: opts.prompt, idPrefix: `mask-${crypto.randomUUID().slice(0, 8)}` });
  return { objects, billedFrames, capped };
}
