// Vibe特效 3D（spec §5.7）：一句描述 → 閘道請 Muse Wonder 寫 three.js 插件（或只填內建吉祥物的參數）→ 3D 沙盒試跑
// （載入、setup、開頭／中間／結尾三格，至少一格有畫東西）→ 不過就帶錯誤回饋，最多 3 輪 → 加到時間軸（疊在影片上的 anim3d）。
import type { Effect, Plugin } from "../core/model";
import { PluginError } from "../sandbox/sandboxFrame";
import type { ThreeHost } from "../sandbox/threeHost";
import { builtinPlugins3D, hash3D, type Component3D } from "../three/builtins";
import { GatewayClient, type VibeError } from "./gateway";
import { boxToVirtual, VIBE_MESSAGES, type VibeInput, type VibeOutcome, type VibeProgress } from "./vibe";

/** 閘道回來的 3D 結果 */
export interface Vibe3dResult {
  refusal: string | null;
  mode: "params" | "new" | null;
  title: string;
  builtin: string | null;
  params: Record<string, unknown> | null;
  component: { name: string; description: string; params: Component3D["params"]; code: string } | null;
}

/** 參數定義的預設值 */
function defaultsOf(params: Component3D["params"]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).map(([k, d]) => [k, d.default]));
}

/** 3D 疊加特效 */
function overlayEffect(id: string, start: number, duration: number, plugin: Plugin, title: string, params: Record<string, unknown>, box: VibeInput["box"], description: string, mode: string): Effect {
  return { id, kind: "anim3d", start, end: start + duration, pluginId: plugin.hash, anchorIds: [], params: { title, params, box, vibe: { description, mode } } };
}

/** 跑一次 Vibe特效 3D */
export async function runVibe3d(gateway: GatewayClient, three: ThreeHost, input: VibeInput, onProgress: (p: VibeProgress) => void): Promise<VibeOutcome> {
  const { width, box } = boxToVirtual(input.box, input.aspect);
  const jobId = await gateway.startVibe({ description: input.description, screenshot: input.screenshot, duration: input.duration, fps: input.fps, width, box }, "3d");
  let round = 1;
  for (;;) {
    onProgress({ stage: "writing", round });
    const view = await gateway.waitVibe3d(jobId);
    if (view.status === "failed") return { ok: false, message: VIBE_MESSAGES[view.error ?? "invalid-response"] ?? VIBE_MESSAGES["invalid-response"] };
    const result = view.result!;
    if (result.refusal) return { ok: false, message: VIBE_MESSAGES[result.refusal] ?? VIBE_MESSAGES["off-topic"] };
    onProgress({ stage: "checking", round: view.round });

    // 只填內建元件的參數：直接用（內建插件已經試過）
    if (result.mode === "params" && result.builtin) {
      const plugin = (await builtinPlugins3D()).get(result.builtin);
      if (plugin) {
        const component = plugin.component as unknown as Component3D;
        const params = { ...defaultsOf(component.params), ...(result.params ?? {}) };
        return { ok: true, effect: overlayEffect(input.effectId, input.start, input.duration, plugin, result.title || component.name, params, input.box, input.description, "params"), plugins: [plugin] };
      }
    }

    // 新插件：在 3D 沙盒試跑
    const errors: VibeError[] = [];
    if (result.mode === "new" && result.component) {
      const component: Component3D = { id: "ai-3d", kind: "3d", effectKind: "anim3d", name: result.component.name, description: result.component.description, params: result.component.params ?? {}, code: result.component.code };
      const params = defaultsOf(component.params);
      try {
        await three.vet(component.code, { fps: input.fps, duration: input.duration, width: 640, height: 360, params, box: input.box, seed: 1 });
        const hash = await hash3D(component as unknown as Record<string, unknown>);
        const plugin: Plugin = { hash, kind: "3d", source: "vibe", component: { ...component, id: `ai-3d-${hash.slice(0, 8)}` } as unknown as Record<string, unknown> };
        return { ok: true, effect: overlayEffect(input.effectId, input.start, input.duration, plugin, result.title || component.name, params, input.box, input.description, "new"), plugins: [plugin] };
      } catch (e) {
        const pe = e instanceof PluginError ? e : null;
        errors.push({ stage: pe?.stage ?? "runtime", component: 0, message: pe?.message ?? String(e), line: pe?.line ?? null, column: pe?.column ?? null });
      }
    } else {
      errors.push({ stage: "schema", component: null, message: "回應要是 mode=params（內建元件 id 與參數）或 mode=new（新插件）", line: null, column: null });
    }
    if (view.round >= 3) return { ok: false, message: VIBE_MESSAGES.rounds };
    await gateway.feedbackVibe(jobId, errors, "3d");
    round = view.round + 1;
  }
}
