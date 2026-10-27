// 10/27 實測②：統一合成器路線的匯出速度（D24）。
// 合成內容和 ffmpeg 基準完全相同：V1＝整支 bench-11min.mp4；子母畫面＝同一支片從 30 秒處開始、480×270 放在 (1400, 40)；
// 聲音＝主音＋子母畫面音量 0.25。影像用 WebGL2 合成、WebCodecs 編碼（mediabunny 封裝），寫進 OPFS。
// 參數（網址 query）：hw=prefer-hardware|prefer-software|no-preference、seconds=只跑前 N 秒（除錯用）
// 10/27 實測③（含 3D 區段）：scene3d=1 時，時間軸 s3dStart～s3dEnd 秒（預設 60～120）的每一格改走 3D 路線：
//   合成器畫好主畫面＋子母畫面 → createImageBitmap(canvas) → transfer 給專用 Worker（OffscreenCanvas WebGL2 跑 three.js，scene3d.ts）
//   → transferToImageBitmap 傳回 → 合成器整張畫上去 → 編碼。snap=1 時在 3D 區段存幾格 PNG 供目視確認（會拖慢，只在驗證流程時用）。
import {
  ALL_FORMATS,
  AudioSample,
  AudioSampleSink,
  AudioSampleSource,
  BlobSource,
  CanvasSource,
  Input,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  UrlSource,
  VideoSampleSink,
  canEncodeAudio,
  type VideoSample,
} from "mediabunny";

/** 輸出規格（和 ffmpeg 基準一致） */
const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const VIDEO_BITRATE = 8_000_000;
const AUDIO_BITRATE = 160_000;
/** 子母畫面：來源時間偏移、位置與大小、音量 */
const PIP = { offset: 30, x: 1400, y: 40, w: 480, h: 270, gain: 0.25 };
/** 混音時每次輸出的音訊格數 */
const AUDIO_CHUNK = 4096;

/** 給 Playwright 讀的量測狀態 */
interface BenchState {
  status: "running" | "done" | "error";
  hardwareAcceleration: string;
  frames: number;
  totalFrames: number;
  elapsedMs: number;
  encoderConfig?: unknown;
  supportCheck?: unknown;
  audioCodec?: string;
  outputBytes?: number;
  outputDuration?: number;
  webglRenderer?: string;
  /** 3D 區段的量測（scene3d=1 才有） */
  scene3d?: Scene3DStats;
  /** snap=1 時存的畫格（PNG 的 data URL） */
  snapshots?: { name: string; dataUrl: string }[];
  error?: string;
}

/** 3D 區段的分項量測（毫秒，皆為整段累計；除以 frames 得每格平均） */
interface Scene3DStats {
  /** 3D 區段的起訖格（含頭不含尾）與實際處理的格數 */
  startFrame: number;
  endFrame: number;
  frames: number;
  /** 區段總耗時（從區段第一格開始等解碼到最後一格 add 完成），含解碼、合成、3D、編碼 */
  segmentMs: number;
  /** createImageBitmap(canvas)：等合成器的 GPU 工作做完並取出畫面 */
  bitmapMs: number;
  /** postMessage 到 Worker 收到結果為止（Worker 內畫 3D＋transferToImageBitmap＋回傳） */
  roundTripMs: number;
  /** Worker 內部量到的 render＋transferToImageBitmap 時間（不含傳輸） */
  workerMs: number;
  /** 把 3D 結果整張畫回合成器 */
  drawMs: number;
  /** videoSource.add（含 canvas 取格＋送編碼器；編碼器忙時會在這裡等） */
  addMs: number;
  /** probe=1 才有：各階段後強制 gl.finish() 同步，量出 GPU 真正的耗時（會改變管線重疊，只用來看分項，不用來當總耗時） */
  probe?: { composeGpuMs: number; workerGpuMs: number; drawGpuMs: number };
  /** Worker 的 WebGL renderer 名稱 */
  workerRenderer?: string;
}

declare global {
  interface Window {
    __bench: BenchState;
  }
}

const params = new URLSearchParams(location.search);
const hardwareAcceleration = (params.get("hw") ?? "prefer-hardware") as HardwareAcceleration;
const limitSeconds = params.get("seconds") ? Number(params.get("seconds")) : Infinity;
/** 3D 區段：是否開啟、起訖秒數、是否存抽樣畫格 */
const scene3dOn = params.get("scene3d") === "1";
const scene3dStartSec = Number(params.get("s3dStart") ?? 60);
const scene3dEndSec = Number(params.get("s3dEnd") ?? 120);
const snapOn = params.get("snap") === "1";
/** seg=1：不開 3D，但照樣量 s3dStart～s3dEnd 區段的耗時（對照組，算 3D 多花多少） */
const segOn = params.get("seg") === "1";
/** probe=1：3D 各階段後強制 GPU 同步，量分項（診斷用） */
const probeOn = params.get("probe") === "1";
/** 診斷用變體：s3dAa=0 關 MSAA；s3dEcho=1 Worker 只把收到的畫面原樣傳回（不跑 three.js，量純 ImageBitmap 來回的成本） */
const scene3dAa = params.get("s3dAa") !== "0";
const scene3dEcho = params.get("s3dEcho") === "1";
const logEl = document.getElementById("log")!;

window.__bench = { status: "running", hardwareAcceleration, frames: 0, totalFrames: 0, elapsedMs: 0 };

/** 在頁面上印一行訊息 */
function log(message: string) {
  logEl.textContent += `\n${message}`;
}

/** 建立合成器：WebGL2 畫布＋把一張 VideoFrame 畫到指定矩形的 shader */
function createCompositor() {
  const canvas = new OffscreenCanvas(WIDTH, HEIGHT);
  const gl = canvas.getContext("webgl2", { alpha: false, preserveDrawingBuffer: true })!;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  window.__bench.webglRenderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "unknown";

  const vs = `#version 300 es
    in vec2 pos; uniform vec4 rect; out vec2 uv;
    void main() {
      uv = vec2(pos.x, 1.0 - pos.y);
      vec2 p = rect.xy + pos * rect.zw;
      gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
    }`;
  const fs = `#version 300 es
    precision mediump float; in vec2 uv; uniform sampler2D tex; out vec4 color;
    void main() { color = texture(tex, uv); }`;
  const program = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  gl.useProgram(program);

  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const posLoc = gl.getAttribLocation(program, "pos");
  gl.enableVertexAttribArray(posLoc);
  gl.vertexAttribPointer(posLoc, 2, gl.FLOAT, false, 0, 0);
  const rectLoc = gl.getUniformLocation(program, "rect");

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.viewport(0, 0, WIDTH, HEIGHT);

  /** 把一格畫面（VideoFrame 或 ImageBitmap）貼到 (x, y, w, h)（像素座標，左上原點） */
  function draw(frame: TexImageSource, x: number, y: number, w: number, h: number) {
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);
    gl.uniform4f(rectLoc, x / WIDTH, 1 - (y + h) / HEIGHT, w / WIDTH, h / HEIGHT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** 讀 1 個像素＝等 GPU 把這個 context 已送出的命令做完（probe 用；gl.finish() 在 Chromium 幾乎不阻塞） */
  const syncBuf = new Uint8Array(4);
  function sync() { gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncBuf); }

  return { canvas, draw, sync };
}

/** 把一條音軌解成連續的單聲道 Float32 片段（多聲道取平均） */
async function* monoPcm(sink: AudioSampleSink, start: number, end: number): AsyncGenerator<Float32Array> {
  for await (const sample of sink.samples(start, end)) {
    const frames = sample.numberOfFrames;
    const mono = new Float32Array(frames);
    const plane = new Float32Array(frames);
    for (let ch = 0; ch < sample.numberOfChannels; ch++) {
      sample.copyTo(plane, { planeIndex: ch, format: "f32-planar" });
      for (let i = 0; i < frames; i++) mono[i] += plane[i] / sample.numberOfChannels;
    }
    sample.close();
    yield mono;
  }
}

/** 從 PCM 產生器裡依序取出剛好 n 格；來源用完就補 0 */
function pcmReader(source: AsyncGenerator<Float32Array>) {
  let pending: Float32Array = new Float32Array(0);
  let done = false;
  return async function read(n: number): Promise<Float32Array> {
    const out = new Float32Array(n);
    let filled = 0;
    while (filled < n) {
      if (pending.length === 0) {
        if (done) break;
        const next = await source.next();
        if (next.done) { done = true; break; }
        pending = next.value;
      }
      const take = Math.min(n - filled, pending.length);
      out.set(pending.subarray(0, take), filled);
      pending = pending.subarray(take);
      filled += take;
    }
    return out;
  };
}

/**
 * 3D 專用 Worker 的用戶端：init 後每格 render(bitmap, t) 送進去，回傳 3D 算好的整張 ImageBitmap。
 * 一次只會有一格在飛（合成器等結果才往下走），所以用單一 pending 即可。
 */
async function createScene3DClient() {
  const worker = new Worker(new URL("./scene3d.worker.ts", import.meta.url), { type: "module" });
  let pending: ((msg: { bitmap: ImageBitmap; renderMs: number; gpuMs?: number }) => void) | null = null;
  const ready = new Promise<string>((resolve, reject) => {
    worker.onmessage = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === "ready") resolve(msg.renderer);
      else if (msg.type === "frame" && pending) { const done = pending; pending = null; done(msg); }
    };
    worker.onerror = (event) => reject(new Error(`3D Worker 錯誤：${event.message}`));
  });
  worker.postMessage({ type: "init", width: WIDTH, height: HEIGHT, duration: scene3dEndSec - scene3dStartSec, probe: probeOn, antialias: scene3dAa, echo: scene3dEcho, skipTexture: params.get("s3dNoTex") === "1", srgbTexture: params.get("s3dSrgb") === "1" });
  const renderer = await ready;
  return {
    renderer,
    /** 送一格進 Worker（bitmap 以 transfer 傳入），等它畫完傳回 */
    render(bitmap: ImageBitmap, t: number) {
      return new Promise<{ bitmap: ImageBitmap; renderMs: number; gpuMs?: number }>((resolve) => {
        pending = resolve;
        worker.postMessage({ type: "frame", id: 0, t, bitmap }, [bitmap]);
      });
    },
    terminate: () => worker.terminate(),
  };
}

/** 把 canvas 目前內容存成 PNG 的 data URL（snap=1 驗證用） */
async function canvasToPngDataUrl(canvas: OffscreenCanvas): Promise<string> {
  const blob = await canvas.convertToBlob({ type: "image/png" });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(binary)}`;
}

/** 主流程：解碼 → 合成 → 編碼 → 寫入 OPFS，量總耗時 */
async function run() {
  const input = new Input({ source: new UrlSource("/bench-11min.mp4"), formats: ALL_FORMATS });
  const videoTrack = (await input.getPrimaryVideoTrack())!;
  const audioTrack = (await input.getPrimaryAudioTrack())!;
  const duration = Math.min(await input.computeDuration(), limitSeconds);
  const totalFrames = Math.floor(duration * FPS);
  window.__bench.totalFrames = totalFrames;
  log(`duration ${duration.toFixed(1)} s, ${totalFrames} frames, hw=${hardwareAcceleration}`);

  // 編碼器支援度（記錄實際能不能用硬體）
  window.__bench.supportCheck = await VideoEncoder.isConfigSupported({
    codec: "avc1.640028", width: WIDTH, height: HEIGHT, bitrate: VIDEO_BITRATE, framerate: FPS, hardwareAcceleration,
  });
  const audioCodec = (await canEncodeAudio("aac")) ? "aac" : "opus";
  window.__bench.audioCodec = audioCodec;

  // 輸出：OPFS 檔案的可寫串流，邊編碼邊寫（不在記憶體累積）
  const root = await navigator.storage.getDirectory();
  const fileHandle = await root.getFileHandle("bench-out.mp4", { create: true });
  const writable = await fileHandle.createWritable();
  const output = new Output({ format: new Mp4OutputFormat(), target: new StreamTarget(writable, { chunked: true }) });

  const compositor = createCompositor();

  // 3D 區段（scene3d=1）：起訖格、專用 Worker、分項統計
  const s3dStart = Math.round(scene3dStartSec * FPS);
  const s3dEnd = Math.min(totalFrames, Math.round(scene3dEndSec * FPS));
  const client = scene3dOn ? await createScene3DClient() : null;
  const stats: Scene3DStats | null = scene3dOn || segOn
    ? { startFrame: s3dStart, endFrame: s3dEnd, frames: 0, segmentMs: 0, bitmapMs: 0, roundTripMs: 0, workerMs: 0, drawMs: 0, addMs: 0, workerRenderer: client?.renderer }
    : null;
  if (stats) window.__bench.scene3d = stats;
  if (snapOn) window.__bench.snapshots = [];
  /** snap=1 時要抽的格：3D 區段前一格（對照）、第 30 格、中間、倒數第二格 */
  const snapFrames = new Map<number, string>([
    [s3dStart - 1, "before-3d"], [s3dStart + 30, "3d-early"], [Math.floor((s3dStart + s3dEnd) / 2), "3d-mid"], [s3dEnd - 2, "3d-late"],
  ]);
  let segmentStartedAt = 0;
  const videoSource = new CanvasSource(compositor.canvas, {
    codec: "avc", bitrate: VIDEO_BITRATE, keyFrameInterval: 2, hardwareAcceleration,
    onEncoderConfig: (config) => { window.__bench.encoderConfig = config; },
  });
  const audioSource = new AudioSampleSource({ codec: audioCodec, bitrate: AUDIO_BITRATE });
  output.addVideoTrack(videoSource, { frameRate: FPS });
  output.addAudioTrack(audioSource);
  await output.start();

  const started = performance.now();

  // 聲音：主音＋子母畫面音軌，混好後分塊送編碼器（和影像並行）
  const sampleRate = audioTrack.sampleRate;
  const audioJob = (async () => {
    const mainRead = pcmReader(monoPcm(new AudioSampleSink(audioTrack), 0, duration));
    const pipRead = pcmReader(monoPcm(new AudioSampleSink(audioTrack), PIP.offset, duration + PIP.offset));
    const totalSamples = Math.floor(duration * sampleRate);
    for (let pos = 0; pos < totalSamples; pos += AUDIO_CHUNK) {
      const n = Math.min(AUDIO_CHUNK, totalSamples - pos);
      const [main, pip] = await Promise.all([mainRead(n), pipRead(n)]);
      for (let i = 0; i < n; i++) main[i] += pip[i] * PIP.gain;
      const sample = new AudioSample({ data: main, format: "f32-planar", numberOfChannels: 1, sampleRate, timestamp: pos / sampleRate });
      await audioSource.add(sample);
      sample.close();
    }
  })();

  // 影像：兩個解碼串流（主畫面、子母畫面＋30 秒），逐格合成後編碼
  /** 解碼器的硬體偏好（dec=…，預設和編碼器相同） */
  const decoderOptions = { hardwareAcceleration: (params.get("dec") ?? hardwareAcceleration) as HardwareAcceleration };
  const timestamps = function* (offset: number) {
    for (let i = 0; i < totalFrames; i++) yield i / FPS + offset;
  };
  const mainFrames = new VideoSampleSink(videoTrack, decoderOptions).samplesAtTimestamps(timestamps(0));
  const pipFrames = new VideoSampleSink(videoTrack, decoderOptions).samplesAtTimestamps(timestamps(PIP.offset));
  /** 同時向兩個解碼串流要下一格（pipeline=0 時改回逐路等待，用來對照） */
  const pipelined = params.get("pipeline") !== "0";
  const fetchPair = () => (pipelined
    ? Promise.all([mainFrames.next(), pipFrames.next()])
    : mainFrames.next().then(async (m) => [m, await pipFrames.next()] as const));
  // 預先解下一格：編碼這一格的同時，解碼器已經在做下一格
  let nextPair = fetchPair();
  for (let i = 0; i < totalFrames; i++) {
    if (stats && i === s3dStart) segmentStartedAt = performance.now();
    const [mainResult, pipResult] = await nextPair;
    if (i + 1 < totalFrames) nextPair = pipelined ? fetchPair() : nextPair;
    const main = mainResult.value as VideoSample | null;
    const pip = pipResult.value as VideoSample | null;
    if (!pipelined && i + 1 < totalFrames) nextPair = fetchPair();
    if (main) {
      const frame = main.toVideoFrame();
      compositor.draw(frame, 0, 0, WIDTH, HEIGHT);
      frame.close();
      main.close();
    }
    if (pip) {
      const frame = pip.toVideoFrame();
      compositor.draw(frame, PIP.x, PIP.y, PIP.w, PIP.h);
      frame.close();
      pip.close();
    }
    // 3D 區段：把剛合成好的畫面送進 Worker 畫成「螢幕在桌上」，整張取代這一格
    if (stats && client && i >= s3dStart && i < s3dEnd) {
      if (probeOn) {
        const p0 = performance.now();
        compositor.sync();
        stats.probe ??= { composeGpuMs: 0, workerGpuMs: 0, drawGpuMs: 0 };
        stats.probe.composeGpuMs += performance.now() - p0;
      }
      const a = performance.now();
      const bitmap = await createImageBitmap(compositor.canvas);
      const b = performance.now();
      const result = await client.render(bitmap, (i - s3dStart) / FPS);
      const c = performance.now();
      compositor.draw(result.bitmap, 0, 0, WIDTH, HEIGHT);
      result.bitmap.close();
      if (probeOn) {
        const p0 = performance.now();
        compositor.sync();
        stats.probe!.drawGpuMs += performance.now() - p0;
      }
      const d = performance.now();
      stats.frames++;
      stats.bitmapMs += b - a;
      stats.roundTripMs += c - b;
      stats.workerMs += result.renderMs;
      if (probeOn) stats.probe!.workerGpuMs += result.gpuMs ?? 0;
      stats.drawMs += d - c;
    }
    if (snapOn && snapFrames.has(i)) {
      window.__bench.snapshots!.push({ name: `${snapFrames.get(i)}-f${i}`, dataUrl: await canvasToPngDataUrl(compositor.canvas) });
    }
    const addStarted = performance.now();
    await videoSource.add(i / FPS, 1 / FPS);
    if (stats && i >= s3dStart && i < s3dEnd) stats.addMs += performance.now() - addStarted;
    if (stats && i === s3dEnd - 1) stats.segmentMs = performance.now() - segmentStartedAt;
    window.__bench.frames = i + 1;
    window.__bench.elapsedMs = performance.now() - started;
    if (i % 900 === 0) log(`frame ${i}/${totalFrames}  ${(window.__bench.elapsedMs / 1000).toFixed(1)} s`);
  }

  await audioJob;
  client?.terminate();
  await output.finalize();
  window.__bench.elapsedMs = performance.now() - started;

  // 驗證輸出：檔案大小與實際長度
  const file = await fileHandle.getFile();
  window.__bench.outputBytes = file.size;
  const check = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  window.__bench.outputDuration = await check.computeDuration();
  window.__bench.status = "done";
  log(`done in ${(window.__bench.elapsedMs / 1000).toFixed(1)} s, ${(file.size / 1e6).toFixed(1)} MB`);
}

/** 在 Tauri 裡跑時（?report=1），把結果送到本機回聲伺服器（spikes/tauri-env/echo-server.mjs） */
async function reportIfAsked() {
  if (params.get("report") !== "1") return;
  await fetch("http://127.0.0.1:8787/report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ userAgent: navigator.userAgent, ...window.__bench }),
  }).catch(() => undefined);
}

run()
  .catch((error: unknown) => {
    window.__bench.status = "error";
    window.__bench.error = String((error as Error)?.stack ?? error);
    log(`ERROR ${window.__bench.error}`);
  })
  .finally(reportIfAsked);
