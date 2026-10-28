import { describe, expect, it } from "vitest";
import type { JobView } from "./gateway";
import { SYNTH_MESSAGES, runMusic, runSound, type SynthGateway } from "./synth";

/** 假閘道：記下送出的請求，回排好的工作結果 */
function fakeGateway(view: JobView<{ refusal: string | null; spec: unknown }>) {
  const calls: { path: string; body: unknown }[] = [];
  const gateway: SynthGateway = {
    startJob: async (path, body) => { calls.push({ path, body }); return "job-1"; },
    waitJob: async <R,>() => view as unknown as JobView<R>,
  };
  return { gateway, calls };
}

const BEEP = { length: 0.5, voices: [{ source: { type: "osc", wave: "sine", freq: 880 }, env: { attack: 0.01, decay: 0.1, sustain: 0.5, release: 0.1 } }] };
const PAD = { bpm: 120, bars: 2, chords: ["Am", "F"], parts: [{ role: "pad", voice: { source: { type: "osc", wave: "triangle" }, env: { attack: 0.1, decay: 0, sustain: 1, release: 0.3 } }, notes: [{ at: 0, len: 4, chord: 0 }] }] };

describe("runSound／runMusic（閘道 → 前端再驗證一次）", () => {
  it("音效：送描述與長度，回驗證過的 spec", async () => {
    const { gateway, calls } = fakeGateway({ status: "done", round: 1, result: { refusal: null, spec: BEEP }, error: null });
    const r = await runSound(gateway, { description: "beep", length: 0.5 });
    expect(calls).toEqual([{ path: "/v1/ai/sound", body: { description: "beep", length: 0.5, previous: null } }]);
    expect(r).toEqual({ ok: true, spec: BEEP });
  });

  it("配樂改版：帶前一版 spec", async () => {
    const { gateway, calls } = fakeGateway({ status: "done", round: 1, result: { refusal: null, spec: PAD }, error: null });
    const r = await runMusic(gateway, { description: "slower", bars: 2, previous: PAD as never });
    expect(calls[0]).toEqual({ path: "/v1/ai/music", body: { description: "slower", bars: 2, previous: PAD } });
    expect(r.ok).toBe(true);
  });

  it("拒答與失敗顯示固定文字（不顯示模型的文字）", async () => {
    const refused = fakeGateway({ status: "done", round: 1, result: { refusal: "off-topic", spec: null }, error: null });
    expect(await runSound(refused.gateway, { description: "poem", length: 1 })).toEqual({ ok: false, message: SYNTH_MESSAGES["off-topic-sound"] });
    expect(await runMusic(refused.gateway, { description: "poem", bars: 8 })).toEqual({ ok: false, message: SYNTH_MESSAGES["off-topic-music"] });
    const failed = fakeGateway({ status: "failed", round: 2, result: null, error: "invalid-response" });
    expect(await runSound(failed.gateway, { description: "beep", length: 1 })).toEqual({ ok: false, message: SYNTH_MESSAGES["invalid-response"] });
  });

  it("閘道回的 spec 前端驗證不過（版本不一致之類）也當失敗", async () => {
    const { gateway } = fakeGateway({ status: "done", round: 1, result: { refusal: null, spec: { length: 0.5, voices: [] } }, error: null });
    expect(await runSound(gateway, { description: "beep", length: 0.5 })).toEqual({ ok: false, message: SYNTH_MESSAGES["invalid-response"] });
  });
});
