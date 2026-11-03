// Vibe特效（spec §5.7）：一句描述 → 閘道請 Muse Wonder 寫插件 → 沙盒試跑（vet）→ 不過就帶錯誤回饋，最多 3 輪 → 加到時間軸。
// 這支只有純資料轉換與流程；呼叫閘道在 gateway.ts，試跑在沙盒（PluginService.host）。
import type { Effect, Plugin } from "../core/model";
import type { SandboxHost } from "../sandbox/sandboxHost";
import { PluginError } from "../sandbox/sandboxHost";
import type { BuiltinPlugins } from "../anim/pluginService";
import { instanceOf } from "../anim/effectRenderer";
import { GatewayClient, type VibeError } from "./gateway";

/** 閘道回來的結果（拒答，或動畫＋新插件） */
export interface VibeResult {
  refusal: string | null;
  mode: string | null;
  anim: { title: string; layers: Record<string, unknown>[]; sounds: Record<string, unknown>[] };
  components: Record<string, unknown>[];
  targetPhrase: string;
}

/** 目標框（0～1，中心＋寬高） */
export interface Box01 {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** 拒答代碼與失敗代碼 → 給使用者看的固定文字（不顯示模型寫的文字） */
export const VIBE_MESSAGES: Record<string, string> = {
  "off-topic": "That doesn't look like an on-screen effect. Describe what should appear on the video.",
  unsafe: "This can't be made into an effect — effects can only draw on the video.",
  "too-complex": "That's too much for one effect. Try something simpler, or split it into two effects.",
  "invalid-response": "The AI couldn't produce a working effect. Try rephrasing.",
  budget: "The AI couldn't produce a working effect within its budget. Try rephrasing.",
  "model-error": "The AI service didn't respond. Try again in a moment.",
  rounds: "The AI's effect still had errors after 3 tries. Try rephrasing.",
};

/** 0～1 的框 → 1080p 虛擬像素（寬依片子比例），給模型看的目標框 */
export function boxToVirtual(box: Box01, aspect: number): { width: number; box: { x: number; y: number; w: number; h: number } } {
  const width = Math.round(1080 * aspect);
  return { width, box: { x: Math.round((box.cx - box.w / 2) * width), y: Math.round((box.cy - box.h / 2) * 1080), w: Math.round(box.w * width), h: Math.round(box.h * 1080) } };
}

/**
 * 模型結果 → 時間軸上的 2D 特效：圖層的 component 引用換成插件雜湊（"#n" → 第 n 個新插件，id → 內建插件），
 * 圖層的框架屬性原樣保留（由沙盒的 normalizeLayer 驗證）；音效今天先不帶（§5.15 另做）。
 * 找不到的引用丟錯，訊息會回饋給模型。
 */
export function vibeEffect(result: VibeResult, newHashes: string[], builtinHash: (id: string) => string | undefined, id: string, start: number, duration: number, box: Box01, description: string): Effect {
  const layers = result.anim.layers.map((layer, i) => {
    const ref = String(layer.component ?? "");
    const hash = ref.startsWith("#") ? newHashes[Number(ref.slice(1))] : builtinHash(ref);
    if (!hash) throw new Error(`layers[${i}] 的 component「${ref}」不存在（要是 "#n" 或內建視覺插件 id）`);
    return { ...layer, component: hash };
  });
  return {
    id, kind: "anim2d", start, end: start + duration, pluginId: layers[0]?.component ?? "", anchorIds: [],
    params: { title: result.anim.title, box, layers, sounds: [], vibe: { description, mode: result.mode } },
  };
}

/** 進度（給介面顯示） */
export type VibeProgress = { stage: "writing" | "checking" | "textures"; round: number };

/** 一次 Vibe特效的結果：成功（特效＋要加進專案的插件）或失敗（給使用者看的訊息） */
export type VibeOutcome = { ok: true; effect: Effect; plugins: Plugin[] } | { ok: false; message: string };

/** 一次 Vibe特效的條件 */
export interface VibeInput {
  description: string;
  /** 目前這一格的截圖（data URL），選填 */
  screenshot: string | null;
  start: number;
  duration: number;
  box: Box01;
  /** 片子比例（寬 ÷ 高） */
  aspect: number;
  fps: number;
  effectId: string;
}

/** 試跑整段動畫：開頭、中間、結尾各畫一格（框架屬性、引用錯誤在這裡抓到） */
async function trialRender(host: SandboxHost, effect: Effect, fps: number): Promise<void> {
  const duration = effect.end - effect.start;
  for (const t of [0, duration / 2, Math.max(0, duration - 1 / fps)]) {
    const bitmap = await host.request<ImageBitmap>("render", { instance: instanceOf(effect), frame: Math.round(t * fps), fps, duration, width: 640, height: 360, videoW: 1920, videoH: 1080 });
    bitmap.close();
  }
}

/** 跑一次 Vibe特效：開始工作 → 輪詢 → 沙盒試跑 → 回饋，直到成功、拒答或輪數用完 */
export async function runVibe(gateway: GatewayClient, host: SandboxHost, builtins: BuiltinPlugins, input: VibeInput, onProgress: (p: VibeProgress) => void): Promise<VibeOutcome> {
  const { width, box } = boxToVirtual(input.box, input.aspect);
  const jobId = await gateway.startVibe({ description: input.description, screenshot: input.screenshot, duration: input.duration, fps: input.fps, width, box });
  let round = 1;
  for (;;) {
    onProgress({ stage: "writing", round });
    const view = await gateway.waitVibe(jobId);
    if (view.status === "failed") return { ok: false, message: VIBE_MESSAGES[view.error ?? "invalid-response"] ?? VIBE_MESSAGES["invalid-response"] };
    const result = view.result!;
    if (result.refusal) return { ok: false, message: VIBE_MESSAGES[result.refusal] ?? VIBE_MESSAGES["off-topic"] };
    onProgress({ stage: "checking", round: view.round });

    // 新插件逐一在沙盒試跑（結構、編譯、試跑、參數變體）
    const errors: VibeError[] = [];
    const vetted: Plugin[] = [];
    for (const [i, raw] of result.components.entries()) {
      try {
        const { plugin, hash } = await host.request<{ plugin: Record<string, unknown>; hash: string }>("vet", { component: { ...raw, id: "ai-draft", version: 1, schema: 2 }, lintPaths: true }, [], 10_000);
        if (plugin.kind !== "visual") continue;  // 音效插件今天先不用（§5.15 另做）
        vetted[i] = { hash, kind: "2d", source: "vibe", component: plugin };
      } catch (e) {
        const pe = e instanceof PluginError ? e : null;
        errors.push({ stage: pe?.stage ?? "schema", component: i, message: pe?.message ?? String(e), line: pe?.line ?? null, column: pe?.column ?? null });
      }
    }
    if (!errors.length) {
      try {
        const fresh = vetted.filter(Boolean);
        await host.setComponents(fresh.map((p) => p.component));
        const effect = vibeEffect(result, vetted.map((p) => p?.hash ?? ""), (id) => builtins.get(id)?.hash, input.effectId, input.start, input.duration, input.box, input.description);
        await trialRender(host, effect, input.fps);
        const used = effect.params.layers as { component: string }[];
        const builtinUsed = [...builtins.values()].filter((p) => used.some((l) => l.component === p.hash));
        return { ok: true, effect, plugins: [...fresh, ...builtinUsed] };
      } catch (e) {
        const pe = e instanceof PluginError ? e : null;
        errors.push({ stage: pe?.stage ?? "schema", component: null, message: pe?.message ?? (e instanceof Error ? e.message : String(e)), line: pe?.line ?? null, column: pe?.column ?? null });
      }
    }
    if (view.round >= 3) return { ok: false, message: VIBE_MESSAGES.rounds };
    await gateway.feedbackVibe(jobId, errors);
    round = view.round + 1;
  }
}
