// 10/27 實測③路線 A 的專用 Worker：OffscreenCanvas WebGL2 跑 three.js「螢幕在桌上」場景（scene3d.ts）。
// 協定：
//   主頁 → Worker  { type: "init", width, height, duration }
//   Worker → 主頁  { type: "ready", renderer }
//   主頁 → Worker  { type: "frame", id, t, bitmap }（bitmap 以 transfer 傳入）
//   Worker → 主頁  { type: "frame", id, bitmap, renderMs }（bitmap 以 transfer 傳回）
import * as THREE from "three";
import { setup, type Scene3D } from "./scene3d";

let canvas: OffscreenCanvas | null = null;
let scene: Scene3D | null = null;
/** probe：每格畫完後 gl.finish() 量 GPU 真正耗時 */
let probe = false;
const probeBuf = new Uint8Array(4);
/** 診斷：echo＝不畫 3D，原樣傳回收到的畫面 */
let echo = false;

/** 處理主頁訊息：init 建場景，frame 畫一格並把結果轉移回去 */
self.onmessage = (event: MessageEvent) => {
  const msg = event.data;
  if (msg.type === "init") {
    probe = !!msg.probe;
    echo = !!msg.echo;
    canvas = new OffscreenCanvas(msg.width, msg.height);
    scene = setup(THREE, canvas, { width: msg.width, height: msg.height, duration: msg.duration, antialias: msg.antialias, skipTexture: msg.skipTexture, srgbTexture: msg.srgbTexture });
    const gl = scene.renderer.getContext();
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    (self as unknown as Worker).postMessage({
      type: "ready",
      renderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unknown",
    });
  } else if (msg.type === "frame" && echo) {
    (self as unknown as Worker).postMessage({ type: "frame", id: msg.id, bitmap: msg.bitmap, renderMs: 0 }, [msg.bitmap]);
  } else if (msg.type === "frame" && scene && canvas) {
    const started = performance.now();
    scene.render(msg.t, msg.bitmap as ImageBitmap);
    let gpuMs: number | undefined;
    if (probe) {
      const g = performance.now();
      const gl = scene.renderer.getContext();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, probeBuf); // 讀 1 個像素＝真正等 GPU 做完（gl.finish() 在 Chromium 幾乎不阻塞）
      gpuMs = performance.now() - g;
    }
    // 整張畫面轉成 ImageBitmap 傳回（transferToImageBitmap 會等 GPU 畫完）
    const out = canvas.transferToImageBitmap();
    (self as unknown as Worker).postMessage(
      { type: "frame", id: msg.id, bitmap: out, renderMs: performance.now() - started, gpuMs },
      [out],
    );
  }
};
