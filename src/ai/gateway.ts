// 閘道用戶端（spec §6）：網址與邀請權杖存在這台電腦（localStorage；權杖不寫進專案檔、不印 log）。
// 目前用到 Vibe特效的三個端點；之後 ASR、AI 導演等照同樣方式加。
import type { VibeResult } from "./vibe";
import type { Vibe3dResult } from "./vibe3d";

/** 預設閘道（Zeabur，D23） */
export const DEFAULT_GATEWAY = "https://wordblade-api.zeabur.app";
/** 設定存的鍵 */
const SETTINGS_KEY = "wordblade.gateway";

/** 閘道設定 */
export interface GatewaySettings {
  url: string;
  token: string;
}

/** 回饋給模型的錯誤（閘道 VibeError） */
export interface VibeError {
  stage: string;
  component: number | null;
  message: string;
  line: number | null;
  column: number | null;
}

/** 閘道的工作狀態 */
export interface VibeView {
  status: "running" | "done" | "failed";
  round: number;
  result: VibeResult | null;
  error: string | null;
}

/** 閘道錯誤（HTTP 狀態碼與代碼；訊息給使用者看） */
export class GatewayError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "GatewayError";
  }
}

/** 讀設定（沒設過回預設網址、空權杖） */
export function loadSettings(): GatewaySettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { url: DEFAULT_GATEWAY, token: "", ...JSON.parse(raw) };
  } catch {
    /* 讀不到就用預設 */
  }
  return { url: DEFAULT_GATEWAY, token: "" };
}

/** 存設定 */
export function saveSettings(settings: GatewaySettings) {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    /* 存不了就只在這次有效 */
  }
}

/** 等一下 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 閘道用戶端 */
export class GatewayClient {
  constructor(private readonly settings: GatewaySettings) {}

  /** 送請求；HTTP 錯誤轉成 GatewayError */
  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.settings.url.replace(/\/$/, "") + path, {
        ...init,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.settings.token}`, ...(init.headers ?? {}) },
      });
    } catch {
      throw new GatewayError("Can't reach the AI service. Check the address in AI settings and your connection.", 0);
    }
    if (res.status === 401) throw new GatewayError("The invite token isn't valid. Check it in AI settings.", 401);
    if (!res.ok) throw new GatewayError(`The AI service returned an error (${res.status}).`, res.status);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  /** 開始 Vibe特效，回傳工作 id */
  async startVibe(body: { description: string; screenshot: string | null; duration: number; fps: number; width: number; box: { x: number; y: number; w: number; h: number } }, dimension: "2d" | "3d" = "2d"): Promise<string> {
    const { jobId } = await this.call<{ jobId: string }>(dimension === "3d" ? "/v1/ai/vibe3d" : "/v1/ai/vibe", { method: "POST", body: JSON.stringify(body) });
    return jobId;
  }

  /** 等工作離開 running（每秒問一次，最多 3 分鐘） */
  async waitVibe(jobId: string): Promise<VibeView> {
    for (let i = 0; i < 180; i++) {
      const view = await this.call<VibeView>(`/v1/ai/vibe/${encodeURIComponent(jobId)}`);
      if (view.status !== "running") return view;
      await sleep(1000);
    }
    throw new GatewayError("The AI took too long. Try again.", 0);
  }

  /** 沙盒試跑不過：送錯誤續跑 */
  async feedbackVibe(jobId: string, errors: VibeError[], dimension: "2d" | "3d" = "2d"): Promise<void> {
    await this.call<void>(`/v1/ai/${dimension === "3d" ? "vibe3d" : "vibe"}/${encodeURIComponent(jobId)}/feedback`, { method: "POST", body: JSON.stringify({ errors }) });
  }

  /** 等 Vibe特效 3D 的工作離開 running */
  async waitVibe3d(jobId: string): Promise<{ status: "running" | "done" | "failed"; round: number; result: Vibe3dResult | null; error: string | null }> {
    for (let i = 0; i < 180; i++) {
      const view = await this.call<{ status: "running" | "done" | "failed"; round: number; result: Vibe3dResult | null; error: string | null }>(`/v1/ai/vibe3d/${encodeURIComponent(jobId)}`);
      if (view.status !== "running") return view;
      await sleep(1000);
    }
    throw new GatewayError("The AI took too long. Try again.", 0);
  }

  /** 開始「用說的」（板子運鏡），回傳工作 id */
  async startPlane3d(body: { description: string; screenshot: string | null; length: number; width: number; height: number; current: Record<string, unknown> }): Promise<string> {
    const { jobId } = await this.call<{ jobId: string }>("/v1/ai/plane3d", { method: "POST", body: JSON.stringify(body) });
    return jobId;
  }

  /** 等「用說的」工作離開 running */
  async waitPlane3d(jobId: string): Promise<{ status: "running" | "done" | "failed"; round: number; result: { refusal: string | null; proposal: Record<string, unknown> | null } | null; error: string | null }> {
    for (let i = 0; i < 120; i++) {
      const view = await this.call<{ status: "running" | "done" | "failed"; round: number; result: { refusal: string | null; proposal: Record<string, unknown> | null } | null; error: string | null }>(`/v1/ai/plane3d/${encodeURIComponent(jobId)}`);
      if (view.status !== "running") return view;
      await sleep(1000);
    }
    throw new GatewayError("The AI took too long. Try again.", 0);
  }

  /** 「用說的」的提議檢查不過：送錯誤續跑 */
  async feedbackPlane3d(jobId: string, errors: VibeError[]): Promise<void> {
    await this.call<void>(`/v1/ai/plane3d/${encodeURIComponent(jobId)}/feedback`, { method: "POST", body: JSON.stringify({ errors }) });
  }
}
