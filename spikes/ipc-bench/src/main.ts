// 10/27 實測③路線 B（ffmpeg 退路）的前端：3D 區段每一格都「經 Tauri IPC 取一格 → three.js 算 3D → readPixels → 經 IPC 送回」。
// 3D 場景用 spikes/export-bench/src/scene3d.ts（和統一合成器路線同一份）。
//
// 為什麼在主執行緒算 three.js、不放 Worker：
//   這條路的瓶頸是 IPC 與 ffmpeg，Worker 只會多一趟 ImageBitmap 轉移（2.5～5 ms／格）。主執行緒是這條路成本的下限，
//   對退路有利（若把 Worker 的轉移成本算進去，退路只會更慢）；同時 invoke 是非同步的，主執行緒在等 IPC 時不會卡住別的事。
//
// 迴圈：預設照任務描述逐格串行（取格 → 算 → 送格，每步都 await）；IPCB_PIPE=1 時改管線化
// （算第 i 格的同時預取第 i+1 格、送格不等回應），當作這條路的上限參考。
import { invoke } from "@tauri-apps/api/core";
import * as THREE from "three";
import { setup } from "../../export-bench/src/scene3d";

const W = 1920;
const H = 1080;
const FPS = 30;
const ROW = W * 4;

/** fb_config 回傳的量測設定 */
interface Config {
  t0: number;
  dur: number;
  frames: number;
  pipe: boolean;
  snap: boolean;
  tag: string;
}

/** 在頁面上印一行訊息 */
function log(message: string) {
  document.getElementById("log")!.textContent += `\n${message}`;
}

/** 把 readPixels 的結果（原點在左下）上下翻成左上原點，寫進 dst */
function flipRows(src: Uint8Array, dst: Uint8Array) {
  for (let y = 0; y < H; y++) {
    dst.set(src.subarray((H - 1 - y) * ROW, (H - y) * ROW), y * ROW);
  }
}

/** 把一格 rgba 位元組存成 PNG 交給 Rust 寫檔（抽樣驗證用） */
async function savePng(name: string, rgba: Uint8Array) {
  const canvas = new OffscreenCanvas(W, H);
  canvas.getContext("2d")!.putImageData(new ImageData(new Uint8ClampedArray(rgba.buffer.slice(rgba.byteOffset, rgba.byteOffset + rgba.byteLength)), W, H), 0, 0);
  const blob = await canvas.convertToBlob({ type: "image/png" });
  await invoke("fb_save", new Uint8Array(await blob.arrayBuffer()), { headers: { "x-name": name } });
}

/** 主流程：開兩個 ffmpeg → 逐格往返 → 關閉 → 回報結果 */
async function run() {
  const cfg = await invoke<Config>("fb_config");
  const totalFrames = cfg.frames > 0 ? cfg.frames : Math.round(cfg.dur * FPS);
  log(`t0=${cfg.t0} dur=${cfg.dur} frames=${totalFrames} pipe=${cfg.pipe} snap=${cfg.snap}`);

  // 場景（主執行緒的 OffscreenCanvas WebGL2）；readPixels 在 render 之後同一個工作內做，不需要 preserveDrawingBuffer
  const canvas = new OffscreenCanvas(W, H);
  const scene = setup(THREE, canvas, { width: W, height: H, duration: cfg.dur });
  const gl = scene.renderer.getContext() as WebGL2RenderingContext;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const webglRenderer = debug ? String(gl.getParameter(debug.UNMASKED_RENDERER_WEBGL)) : "unknown";

  const readBuf = new Uint8Array(W * H * 4);
  const outBufs = [new Uint8Array(W * H * 4), new Uint8Array(W * H * 4)]; // 管線化時雙緩衝
  /** 各步驟累計耗時（ms） */
  const t = { ipcGet: 0, bitmap: 0, renderRead: 0, flip: 0, ipcPush: 0, snap: 0 };
  const snapAt = new Map<number, string>([[30, "b-3d-early"], [Math.floor(totalFrames / 2), "b-3d-mid"], [totalFrames - 2, "b-3d-late"]]);

  const started = performance.now();
  await invoke("fb_open", { t0: cfg.t0, dur: cfg.dur });

  /** 取一格並轉成 ImageBitmap（IPC 取格與 createImageBitmap 分開計時） */
  const getFrame = async () => {
    const a = performance.now();
    const buf = await invoke<ArrayBuffer>("fb_next");
    const b = performance.now();
    const bitmap = await createImageBitmap(new ImageData(new Uint8ClampedArray(buf), W, H));
    t.ipcGet += b - a;
    t.bitmap += performance.now() - b;
    return bitmap;
  };

  let pendingPush: Promise<unknown> = Promise.resolve();
  let nextFrame = cfg.pipe ? getFrame() : null;
  for (let i = 0; i < totalFrames; i++) {
    const bitmap = cfg.pipe ? await nextFrame! : await getFrame();
    if (cfg.pipe && i + 1 < totalFrames) nextFrame = getFrame(); // 預取下一格，和下面的算繪重疊

    const c = performance.now();
    scene.render(i / FPS, bitmap);
    gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, readBuf);
    const d = performance.now();
    const out = outBufs[i % 2];
    flipRows(readBuf, out);
    const e = performance.now();
    t.renderRead += d - c;
    t.flip += e - d;

    if (cfg.snap && snapAt.has(i)) {
      const s = performance.now();
      await savePng(`snap-${snapAt.get(i)}-f${i}.png`, out);
      t.snap += performance.now() - s;
    }

    if (cfg.pipe) {
      await pendingPush; // 上一格送完才送這一格（Rust 端佇列有序）
      pendingPush = invoke("fb_push", out);
    } else {
      const f = performance.now();
      await invoke("fb_push", out);
      t.ipcPush += performance.now() - f;
    }
    if (i % 300 === 0) log(`frame ${i}/${totalFrames}  ${((performance.now() - started) / 1000).toFixed(1)} s`);
  }
  await pendingPush;
  const loopMs = performance.now() - started;
  const rust = JSON.parse(await invoke<string>("fb_close"));
  const totalMs = performance.now() - started;

  const per = (ms: number) => ms / totalFrames;
  const result = {
    userAgent: navigator.userAgent,
    webglRenderer,
    config: cfg,
    frames: totalFrames,
    /// 從 fb_open 到編碼端 ffmpeg 結束（含 ffmpeg 啟動與收尾），扣掉抽樣存檔
    totalSeconds: (totalMs - t.snap) / 1000,
    loopSeconds: (loopMs - t.snap) / 1000,
    perFrameMs: {
      ipcGet: per(t.ipcGet),
      createImageBitmap: per(t.bitmap),
      renderAndReadPixels: per(t.renderRead),
      flipRows: per(t.flip),
      ipcPush: per(t.ipcPush),
      total: (loopMs - t.snap) / totalFrames,
    },
    rust,
    rustPerFrameMs: {
      nextTotal: rust.nextTotalMs / rust.nextCalls,
      nextQueueWait: rust.nextQueueWaitMs / rust.nextCalls,
      pushTotal: rust.pushTotalMs / rust.pushCalls,
      pushQueueWait: rust.pushQueueWaitMs / rust.pushCalls,
    },
  };
  log(JSON.stringify(result, null, 1));
  await invoke("fb_report", { json: JSON.stringify(result, null, 2), tag: cfg.tag });
}

run()
  .catch(async (error: unknown) => {
    const message = String((error as Error)?.stack ?? error);
    log(`ERROR ${message}`);
    const cfg = await invoke<Config>("fb_config").catch(() => ({ tag: "error" }) as Config);
    await invoke("fb_report", { json: JSON.stringify({ error: message }), tag: cfg.tag });
  })
  .finally(() => invoke("fb_exit"));
