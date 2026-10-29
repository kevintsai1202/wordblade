// AI 導演的閘道呼叫（spec §5.11；閘道 /v1/ai/director）：建工作、逐段上傳（multipart）、輪詢、取消。
// 放在獨立檔案，和 ai/gateway.ts 共用設定（網址、權杖）與錯誤型別。
import { GatewayError, type GatewaySettings } from "../ai/gateway";
import type { Suggestion } from "../core/model";

/** 閘道回的剪輯腳本一項（素材時間；前端補上素材、狀態，id 加上前綴） */
export interface DirectorSuggestion {
  /** 閘道的項目 id（i1、i2…） */
  id: string;
  kind: Suggestion["kind"];
  start: number;
  end: number;
  reason: string;
  payload: Record<string, unknown>;
  purpose: string;
  quote: string;
  chapter: number;
  /** 審查結果（還沒審查是 null） */
  review: { verdict: "keep" | "revised" | "added" | "drop"; note: string } | null;
}

/** 閘道回的章節（素材時間） */
export interface DirectorChapterView {
  title: string;
  start: number;
  end: number;
}

/** 工作狀態 */
export interface DirectorView {
  /** collecting（收段落、逐段分析中）、planning（規劃中）、planned（等縮圖總表）、reviewing（審查中）、done、failed、cancelled */
  status: "collecting" | "planning" | "planned" | "reviewing" | "done" | "failed" | "cancelled";
  segmentsDone: number;
  segmentsTotal: number;
  segmentsFailed: number;
  chapters: DirectorChapterView[];
  suggestions: DirectorSuggestion[];
  /** 審查刪掉的 */
  removed: DirectorSuggestion[];
  error: string | null;
}

/** 一段的詞與畫面變化區（素材時間） */
export interface SegmentMeta {
  start: number;
  end: number;
  words: { id: string; t: number; text: string }[];
  activities?: { id: string; start: number; end: number; x: number; y: number; w: number; h: number }[];
}

/** 送請求；HTTP 錯誤轉成 GatewayError */
async function call<T>(settings: GatewaySettings, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(settings.url.replace(/\/$/, "") + path, { ...init, headers: { authorization: `Bearer ${settings.token}`, ...(init.headers ?? {}) } });
  } catch {
    throw new GatewayError("Can't reach the AI service. Check the address in AI settings and your connection.", 0);
  }
  if (res.status === 401) throw new GatewayError("The invite token isn't valid. Check it in AI settings.", 401);
  if (res.status === 429) throw new GatewayError("The AI director is busy. Try again in a moment.", 429);
  if (res.status === 413) throw new GatewayError("A part of the video is too large to upload.", 413);
  if (!res.ok) throw new GatewayError(`The AI service returned an error (${res.status}).`, res.status);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** AI 導演的閘道用戶端 */
export class DirectorApi {
  constructor(private readonly settings: GatewaySettings) {}

  /** 建工作 */
  async start(body: { mediaName: string; duration: number; segments: number; scenes: { id: string; name: string }[] }): Promise<string> {
    const { jobId } = await call<{ jobId: string }>(this.settings, "/v1/ai/director", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return jobId;
  }

  /** 上傳一段（影片＋詞） */
  async upload(jobId: string, index: number, meta: SegmentMeta, video: Uint8Array): Promise<void> {
    const form = new FormData();
    form.append("video", new Blob([video as Uint8Array<ArrayBuffer>], { type: "video/mp4" }), "segment.mp4");
    form.append("meta", JSON.stringify(meta));
    await call<void>(this.settings, `/v1/ai/director/${encodeURIComponent(jobId)}/segments/${index}`, { method: "POST", body: form });
  }

  /** 審查：送縮圖總表（每項一格、標上項目 id；沒有就只看文字） */
  async review(jobId: string, sheet: Blob | null): Promise<void> {
    const form = new FormData();
    if (sheet) form.append("sheet", sheet, sheet.type === "image/png" ? "sheet.png" : "sheet.jpg");
    await call<void>(this.settings, `/v1/ai/director/${encodeURIComponent(jobId)}/review`, { method: "POST", body: form });
  }

  /** 狀態與建議 */
  poll(jobId: string): Promise<DirectorView> {
    return call<DirectorView>(this.settings, `/v1/ai/director/${encodeURIComponent(jobId)}`);
  }

  /** 取消 */
  async cancel(jobId: string): Promise<void> {
    await call<void>(this.settings, `/v1/ai/director/${encodeURIComponent(jobId)}`, { method: "DELETE" });
  }
}
