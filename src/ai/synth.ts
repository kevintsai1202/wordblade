// AI 音效與 AI 音樂（spec §5.15、D27）：一句描述 → 閘道請 Muse Spark 回宣告式 spec（閘道已用 JSON Schema 驗證，不合格重問一次）
// → 前端用同一份 schema 再驗證一次（不信任網路回來的資料）→ 呼叫端用 audio/synth/render 算成 WAV。
import { validateMusic, validateSound, type MusicSpec, type SoundSpec } from "../audio/synth/spec";
import type { GatewayClient } from "./gateway";

/** 用到的閘道功能（測試可以換成假的） */
export type SynthGateway = Pick<GatewayClient, "startJob" | "waitJob">;

/** 閘道回的結果 */
interface SynthResult {
  refusal: string | null;
  spec: unknown;
}

/** 拒答與失敗代碼 → 給使用者看的固定文字 */
export const SYNTH_MESSAGES: Record<string, string> = {
  "off-topic-sound": "That doesn't sound like a sound effect. Describe a short sound, e.g. \"a soft whoosh\" or \"keyboard typing\".",
  "off-topic-music": "That doesn't sound like background music. Describe a style, tempo or mood, e.g. \"calm lo-fi, 80 BPM\".",
  "invalid-response": "The AI couldn't produce a valid result. Try rephrasing.",
  budget: "The AI couldn't produce a valid result. Try rephrasing.",
  "model-error": "The AI service didn't respond. Try again in a moment.",
};

/** 結果：成功帶驗證過的 spec，失敗帶固定文字 */
export type SynthOutcome<S> = { ok: true; spec: S } | { ok: false; message: string };

/** 跑一個工作並驗證結果（kind 決定拒答訊息與驗證規則） */
async function run<S>(gateway: SynthGateway, path: string, body: unknown, kind: "sound" | "music", validate: (raw: unknown) => { ok: true; spec: S } | { ok: false; errors: string[] }): Promise<SynthOutcome<S>> {
  const jobId = await gateway.startJob(path, body);
  const view = await gateway.waitJob<SynthResult>(path, jobId);
  if (view.status === "failed" || !view.result) return { ok: false, message: SYNTH_MESSAGES[view.error ?? "invalid-response"] ?? SYNTH_MESSAGES["invalid-response"] };
  if (view.result.refusal) return { ok: false, message: SYNTH_MESSAGES[`off-topic-${kind}`] };
  const checked = validate(view.result.spec);
  return checked.ok ? { ok: true, spec: checked.spec } : { ok: false, message: SYNTH_MESSAGES["invalid-response"] };
}

/** AI 音效：描述＋長度（秒）；previous 是前一版 spec（改版時） */
export function runSound(gateway: SynthGateway, input: { description: string; length: number; previous?: SoundSpec | null }): Promise<SynthOutcome<SoundSpec>> {
  return run(gateway, "/v1/ai/sound", { description: input.description, length: input.length, previous: input.previous ?? null }, "sound", validateSound);
}

/** AI 音樂：描述＋小節數；previous 是前一版 spec（「改一下」時） */
export function runMusic(gateway: SynthGateway, input: { description: string; bars: number; previous?: MusicSpec | null }): Promise<SynthOutcome<MusicSpec>> {
  return run(gateway, "/v1/ai/music", { description: input.description, bars: input.bars, previous: input.previous ?? null }, "music", validateMusic);
}
