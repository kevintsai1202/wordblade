import { describe, expect, it } from "vitest";
import type { Media } from "../core/model";
import { beginBusy, isBusy } from "../core/busy";
import { ThumbScheduler, ThumbStore, type ThumbEngine } from "./thumbStore";
import type { DoneMap } from "./thumbs";

/** 假的 Engine：記錄產生了哪些段；thumbStatus 回傳記住的結果 */
function fakeEngine(initial: Record<string, DoneMap> = {}) {
  const done: Record<string, DoneMap> = structuredClone(initial);
  const made: string[] = [];
  let urls = 0;
  const engine: ThumbEngine = {
    async thumbStatus(m) { return structuredClone(done[m.id] ?? [[], [], []]); },
    async makeThumbs(m, tier, chunk) {
      made.push(`${m.id}:${tier}:${chunk}`);
      done[m.id] ??= [[], [], []];
      done[m.id][tier].push(chunk);
    },
    async thumbUrl(m, tier, index) { urls++; return `u:${m.id}:${tier}:${index}`; },
  };
  return { engine, made, urlCalls: () => urls };
}

const video = (id: string, duration: number): Media => ({ id, name: id, kind: "video", duration, path: `${id}.mp4`, audio: true });

/** 等條件成立（最多 2 秒） */
async function until(cond: () => boolean) {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
}

describe("ThumbStore", () => {
  it("sync 讀回快取裡做好的段（重開專案不重做）；只追蹤影片", async () => {
    const { engine } = fakeEngine({ a: [[0], [0], []] });
    const store = new ThumbStore(engine);
    await store.sync([video("a", 30), { ...video("s", 3), kind: "audio" }]);
    expect(store.items().map((i) => i.mediaId)).toEqual(["a"]);
    expect(store.pick("a", 3)).toEqual({ tier: 1, index: 2, time: 4 });
  });

  it("url 第一次回 null 並在背景取得，取得後通知、之後直接回傳", async () => {
    const { engine, urlCalls } = fakeEngine({ a: [[0], [], []] });
    const store = new ThumbStore(engine);
    await store.sync([video("a", 30)]);
    let notified = 0;
    store.subscribe(() => notified++);
    const ref = store.pick("a", 2)!;
    expect(store.url("a", ref)).toBeNull();
    await until(() => store.url("a", ref) !== null);
    expect(store.url("a", ref)).toBe("u:a:0:0");
    expect(notified).toBeGreaterThan(0);
    expect(urlCalls()).toBe(1);
  });

  it("thumbnailAt：取做好的最細一層、最近的一張（AI 導演用）", async () => {
    const { engine } = fakeEngine({ a: [[0], [0], []] });
    engine.thumbUrl = async (_m, tier, index) => `data:text/plain,${tier}-${index}`;
    const store = new ThumbStore(engine);
    await store.sync([video("a", 30)]);
    const shot = await store.thumbnailAt("a", 7.2);
    expect(shot).toMatchObject({ time: 8, width: 320 });
    expect(await shot!.blob.text()).toBe("1-4");
    expect(await store.thumbnailAt("zzz", 1)).toBeNull();
  });

  it("影格條同時要上千張時不會互相擠掉一直重抓；同一輪的變動只通知一次", async () => {
    const { engine, urlCalls } = fakeEngine({ a: [[0, 1, 2, 3, 4, 5, 6, 7], [], [0, 1, 2, 3, 4, 5, 6, 7]] });
    const store = new ThumbStore(engine);
    await store.sync([video("a", 480)]);
    let notified = 0;
    store.subscribe(() => notified++);
    const refs = Array.from({ length: 900 }, (_, i) => ({ tier: 2, index: i }));
    for (const r of refs) store.url("a", r);
    await until(() => refs.every((r) => store.url("a", r) !== null));
    expect(urlCalls()).toBe(900);
    expect(store.url("a", refs[0])).toBe("u:a:2:0");
    expect(notified).toBeLessThan(50);
  });

  it("取不到的縮圖不會每次都再問", async () => {
    const { engine } = fakeEngine({ a: [[0], [], []] });
    let calls = 0;
    engine.thumbUrl = async () => { calls++; return null; };
    const store = new ThumbStore(engine);
    await store.sync([video("a", 30)]);
    store.url("a", { tier: 0, index: 0 });
    await new Promise((r) => setTimeout(r, 10));
    store.url("a", { tier: 0, index: 0 });
    store.url("a", { tier: 0, index: 0 });
    expect(calls).toBe(1);
  });

  it("runTier：一層的每一段依序做完", async () => {
    const { engine, made } = fakeEngine();
    const store = new ThumbStore(engine);
    await store.sync([video("a", 130)]);
    await store.runTier("a", 0);
    expect(made).toEqual(["a:0:0", "a:0:1", "a:0:2"]);
    expect(store.pick("a", 125)?.tier).toBe(0);
  });
});

describe("ThumbScheduler：空檔才做，一段一段做", () => {
  it("忙（播放中或有重工作）時停下；空了再接著做到全部完成", async () => {
    const { engine, made } = fakeEngine({ a: [[0], [], []] });
    const store = new ThumbStore(engine);
    await store.sync([video("a", 4)]);
    let playing = true;
    const scheduler = new ThumbScheduler(store, () => !playing && !isBusy(), 5);
    scheduler.start();
    await new Promise((r) => setTimeout(r, 40));
    expect(made).toEqual([]);
    playing = false;
    const end = beginBusy();
    await new Promise((r) => setTimeout(r, 40));
    expect(made).toEqual([]);
    end();
    await until(() => made.length === 2);
    expect(made).toEqual(["a:1:0", "a:2:0"]);
    scheduler.stop();
  });

  it("產生失敗的素材跳過，不會一直重試", async () => {
    const { engine, made } = fakeEngine({ a: [[0], [], []], b: [[0], [], []] });
    engine.makeThumbs = async (m, tier, chunk) => {
      made.push(`${m.id}:${tier}:${chunk}`);
      if (m.id === "a") throw new Error("decode failed");
    };
    const store = new ThumbStore(engine);
    await store.sync([video("a", 4), video("b", 4)]);
    const scheduler = new ThumbScheduler(store, () => true, 5);
    scheduler.start();
    await until(() => made.includes("b:1:0"));
    await new Promise((r) => setTimeout(r, 40));
    expect(made.filter((m) => m.startsWith("a:")).length).toBe(1);
    scheduler.stop();
  });
});
