// SAM 的閘道呼叫（spec §5.3；閘道 /v1/sam、/v1/ai/mask-phrase）：開始工作（multipart 上傳小檔）、輪詢逐格輸出、取消、目標翻譯。
// 放在獨立檔案，和 ai/gateway.ts 共用設定（網址、權杖）與錯誤型別。
import { GatewayError, type GatewaySettings } from "../ai/gateway";
import type { LocateFrame } from "./locate";

/** 閘道回的工作狀態 */
export interface SamJobView {
  status: "running" | "done" | "failed" | "cancelled";
  /** 游標之後的逐格輸出（一格一行） */
  lines: string[];
  next: number;
  framesProcessed: number;
  error: string | null;
}

/** 送請求；HTTP 錯誤轉成 GatewayError（訊息給使用者看） */
async function call<T>(settings: GatewaySettings, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(settings.url.replace(/\/$/, "") + path, { ...init, headers: { authorization: `Bearer ${settings.token}`, ...(init.headers ?? {}) } });
  } catch {
    throw new GatewayError("Can't reach the AI service. Check the address in AI settings and your connection.", 0);
  }
  if (res.status === 401) throw new GatewayError("The invite token isn't valid. Check it in AI settings.", 401);
  if (res.status === 429) throw new GatewayError("The masking service is busy. Try again in a moment.", 429);
  if (res.status === 413) throw new GatewayError("The clip is too large to upload. Choose a shorter range.", 413);
  if (!res.ok) throw new GatewayError(`The AI service returned an error (${res.status}).`, res.status);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

/** SAM 的閘道用戶端 */
export class SamApi {
  constructor(private readonly settings: GatewaySettings) {}

  /** 開始一個 SAM 工作；回傳工作 id */
  async start(prompt: string, clip: Uint8Array): Promise<string> {
    const form = new FormData();
    form.append("prompt", prompt);
    form.append("clip", new Blob([clip as Uint8Array<ArrayBuffer>], { type: "video/mp4" }), "clip.mp4");
    const { jobId } = await call<{ jobId: string }>(this.settings, "/v1/sam", { method: "POST", body: form });
    return jobId;
  }

  /** 游標 after 之後的狀態與逐格輸出 */
  poll(jobId: string, after: number): Promise<SamJobView> {
    return call<SamJobView>(this.settings, `/v1/sam/${encodeURIComponent(jobId)}?after=${after}`);
  }

  /** 取消 */
  async cancel(jobId: string): Promise<void> {
    await call<void>(this.settings, `/v1/sam/${encodeURIComponent(jobId)}`, { method: "DELETE" });
  }

  /**
   * 螢幕文字定位（Muse Spark）：目標＋幾張畫面（JPEG，同一批最多 8 張）→ 每格的項目與框。輪詢到完成，閘道失敗丟錯。
   */
  async locate(target: string, frames: { t: number; jpeg: Uint8Array }[], signal?: AbortSignal): Promise<LocateFrame[]> {
    const form = new FormData();
    form.append("target", target);
    form.append("times", JSON.stringify(frames.map((f) => f.t)));
    for (const f of frames) form.append("frame", new Blob([f.jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" }), `${f.t}.jpg`);
    const { jobId } = await call<{ jobId: string }>(this.settings, "/v1/ai/locate", { method: "POST", body: form });
    for (;;) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const view = await call<{ status: string; frames: LocateFrame[]; error: string | null }>(this.settings, `/v1/ai/locate/${encodeURIComponent(jobId)}`);
      if (view.status === "done") return view.frames;
      if (view.status === "failed") throw new GatewayError("The AI couldn't read the text positions. Try again.", 502);
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  /** 任何語言的目標 → 英文名詞片語（不是畫面上看得到的東西回空字串） */
  async phrase(text: string): Promise<string> {
    const { phrase } = await call<{ phrase: string }>(this.settings, "/v1/ai/mask-phrase", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    return phrase;
  }
}
