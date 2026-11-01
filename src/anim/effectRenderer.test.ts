import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Effect, Project } from "../core/model";
import type { SandboxHost } from "../sandbox/sandboxHost";
import type { ThreeHost } from "../sandbox/threeHost";

// 特效音效的 blob URL 要釋放（2026-11-01）：專案裡不再用到的音效在 pruneSounds 釋放，dispose 全部釋放。
// Node 沒有 OfflineAudioContext：算聲音的部分換成假的，只看 URL 的建立與釋放。
vi.mock("./effectSound", async (orig) => ({
  ...(await orig<typeof import("./effectSound")>()),
  renderSound: async () => ({}) as AudioBuffer,
  wavBlob: () => new Blob(["x"]),
}));

const { EffectRenderer } = await import("./effectRenderer");

/** 帶音效的 2D 特效（id 與長度不同，soundKey 就不同） */
function fx(id: string): Effect {
  return { id, kind: "anim2d", start: 0, end: 2, params: { sounds: [{ component: "h", params: {}, at: 0 }] } } as unknown as Effect;
}

describe("EffectRenderer 特效音效的 URL", () => {
  let created = 0;
  const revoked: string[] = [];
  beforeEach(() => {
    created = 0;
    revoked.length = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:${++created}`);
    vi.spyOn(URL, "revokeObjectURL").mockImplementation((u) => void revoked.push(u));
  });
  afterEach(() => vi.restoreAllMocks());

  const host = { request: async () => [{ index: 0, at: 0, seconds: 1, events: [], seed: 1 }] } as unknown as SandboxHost;
  const three = { prune: () => undefined } as unknown as ThreeHost;

  it("專案拿掉的特效，音效 URL 在 pruneSounds 釋放；還在用的不動", async () => {
    const r = new EffectRenderer(host, three, () => undefined);
    const a = await r.sound(fx("a"));
    const b = await r.sound(fx("b"));
    await r.pruneSounds({ effects: [fx("a")] } as unknown as Project);
    expect(revoked).toEqual([b!.url]);
    // 還在用的照樣從快取拿，不重算
    expect((await r.sound(fx("a")))!.url).toBe(a!.url);
    expect(created).toBe(2);
  });

  it("dispose 釋放全部音效 URL", async () => {
    const r = new EffectRenderer(host, three, () => undefined);
    await r.sound(fx("a"));
    await r.sound(fx("b"));
    await r.disposeSounds();
    expect(revoked.sort()).toEqual(["blob:1", "blob:2"]);
  });
});
