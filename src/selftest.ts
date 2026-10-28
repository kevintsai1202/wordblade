// 桌面版自我檢查（只在 WORDBLADE_SELFTEST 環境變數啟動時跑，見 scripts/desktop-selftest/run.ps1）：
// 在真正的 WebView2 裡檢查匯入與預覽的關鍵路徑，結果 POST 回本機的回報伺服器。
// 檢查：ffmpeg 位置與選到的編碼器、ffprobe、縮圖、音量包絡、540p 代理檔、asset 協定（Range、CORS 標頭）、
// <video> 拖動與畫到畫布（跨來源汙染）、<audio> 接上 Web Audio 後有沒有聲音（原專案遇過 WebView2 整條靜音）、
// 代理檔快取重用、帶透明影片的代理檔保有透明度、跨來源隔離（COOP／COEP）、示範素材資料夾、麥克風權限。
import { invoke } from "@tauri-apps/api/core";
import { ensureAudioGraph } from "./audio/audioGraph";
import { createEngine } from "./engine/createEngine";
import { TEMPLATES, templateEffect } from "./anim/library";
import { PluginService } from "./anim/pluginService";
import { instanceOf } from "./anim/effectRenderer";
import { TEMPLATES_3D, builtinPlugins3D } from "./three/builtins";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { Project } from "./core/model";
import { emptyProject } from "./core/media";
import { placeMedia } from "./core/timeline";
import { mixAudio } from "./export/audioMix";
import { runExport } from "./export/exporter";
import { exportPlan } from "./export/exportPlan";
import { makeSamClip } from "./sam/clip";
import { grabJpegs } from "./sam/frames";
import { encodeWav } from "./asr/wav";

/** 等事件或逾時；回傳事件有沒有發生 */
function waitFor(target: EventTarget, event: string, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    target.addEventListener(event, () => { clearTimeout(timer); resolve(true); }, { once: true });
  });
}

/** 等 ms 毫秒 */
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 檢查一個檔案，回傳各步驟的結果 */
async function checkFile(path: string, index: number): Promise<Record<string, unknown>> {
  const engine = createEngine();
  const out: Record<string, unknown> = { path };
  let t = performance.now();
  /** 經過的毫秒，並重設計時 */
  const lap = () => { const ms = Math.round(performance.now() - t); t = performance.now(); return ms; };
  try {
    const media = await engine.probe({ kind: "path", path, name: path.split(/[\\/]/).pop()! }, `selftest-${index}`);
    out.probe = { ms: lap(), kind: media.kind, duration: media.duration, width: media.width, height: media.height, fps: media.fps, audio: media.audio };
    // 先刪掉這支的代理檔，才量得到第一次產生的時間；第二次 prepare 應該直接重用（快取命中）
    if (media.kind === "video") await invoke("evict_proxy", { path, alpha: media.hasAlpha === true });
    lap();
    let lastProgress = 0;
    const prepared = await engine.prepare(media, (p) => { lastProgress = p; });
    const env = prepared.envelope;
    out.prepare = { ms: lap(), lastProgress, thumbnail: !!prepared.thumbnailUrl, envelopeLength: env?.rms.length ?? 0, envelopePeak: env ? Number(env.rms.reduce((m, v) => Math.max(m, v), 0).toFixed(4)) : 0, proxyPath: prepared.proxyPath ?? null };
    if (prepared.proxyPath) {
      const again = await engine.prepare(media, () => undefined);
      out.proxyCache = { ms: lap(), samePath: again.proxyPath === prepared.proxyPath };
      media.proxyPath = prepared.proxyPath;
    }
    const url = engine.mediaUrl(media);
    out.url = url;
    const res = await fetch(url, { headers: { Range: "bytes=0-1023" } });
    out.asset = { status: res.status, contentRange: res.headers.get("content-range"), acao: res.headers.get("access-control-allow-origin"), type: res.headers.get("content-type") };
    if (media.kind === "video") {
      const v = document.createElement("video");
      v.crossOrigin = "anonymous";
      v.muted = true;
      v.preload = "auto";
      v.src = url;
      const loaded = await waitFor(v, "loadeddata", 10_000);
      v.currentTime = Math.min(2, media.duration / 2);
      const seeked = await waitFor(v, "seeked", 10_000);
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 36;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(v, 0, 0, 64, 36);
      let meanPixel: string | number;
      let meanAlpha: number | null = null;
      try {
        const px = ctx.getImageData(0, 0, 64, 36).data;
        let sum = 0;
        let alpha = 0;
        for (let i = 0; i < px.length; i += 4) {
          sum += px[i] + px[i + 1] + px[i + 2];
          alpha += px[i + 3];
        }
        meanPixel = Math.round(sum / (px.length / 4));
        meanAlpha = Math.round(alpha / (px.length / 4));
      } catch (e) {
        meanPixel = `tainted: ${String(e)}`;
      }
      // meanAlpha：不透明影片是 255；帶透明的（測試素材是 50% 紅）應該明顯小於 255
      out.video = { loaded, seeked, readyState: v.readyState, videoWidth: v.videoWidth, videoHeight: v.videoHeight, meanPixel, meanAlpha };
      v.removeAttribute("src");
    }
    if (media.audio) {
      const a = document.createElement("audio");
      a.crossOrigin = "anonymous";
      a.src = url;
      await waitFor(a, "loadeddata", 10_000);
      a.currentTime = Math.min(1, media.duration / 3);
      const graph = ensureAudioGraph()!;
      const clipId = `selftest-${index}`;
      graph.connect(clipId, a, "A1");
      graph.setClipGain(clipId, 1);
      let playError: string | null = null;
      await a.play().catch((e: unknown) => { playError = String(e); });
      // 播 1.5 秒，取最大的輸出音量
      let peak = 0;
      for (let i = 0; i < 15; i++) {
        await sleep(100);
        peak = Math.max(peak, graph.level());
      }
      a.pause();
      graph.drop(clipId);
      out.audio = { contextState: graph.ctx.state, playError, peakLevel: Number(peak.toFixed(4)), elementTime: Number(a.currentTime.toFixed(2)) };
    }
  } catch (e) {
    out.error = String(e);
  }
  return out;
}

/** 麥克風：getUserMedia 等 8 秒；回 ok、錯誤名稱（NotAllowedError 多半是 Windows 隱私權設定關掉了桌面應用程式的麥克風）或 timeout */
async function checkMicrophone(): Promise<string> {
  const request = navigator.mediaDevices.getUserMedia({ audio: true }).then(
    (stream) => {
      const label = stream.getAudioTracks()[0]?.label ?? "";
      stream.getTracks().forEach((t) => t.stop());
      return `ok (${label})`;
    },
    (e: unknown) => (e instanceof DOMException ? e.name : String(e)),
  );
  return Promise.race([request, sleep(8000).then(() => "timeout")]);
}

/** 2D 特效沙盒（spec §5.7 要在 WebView2 重測）：沒有 same-origin 的 iframe → Worker → 直譯器畫紅框範本，讀回像素 */
async function checkSandbox(): Promise<Record<string, unknown>> {
  const t0 = performance.now();
  const service = new PluginService();
  try {
    const builtins = await service.builtins();
    const bootMs = Math.round(performance.now() - t0);
    const template = TEMPLATES.find((t) => t.id === "box-ding")!;
    const effect = templateEffect(template, (id) => builtins.get(id)!.hash, "selftest-fx", 0);
    const t1 = performance.now();
    const bitmap = await service.host.request<ImageBitmap>("render", { instance: instanceOf(effect), frame: 45, fps: 30, duration: 2.5, width: 640, height: 360, videoW: 1920, videoH: 1080 });
    const renderMs = Math.round(performance.now() - t1);
    const canvas = document.createElement("canvas");
    canvas.width = 640;
    canvas.height = 360;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    const d = ctx.getImageData(0, 0, 640, 360).data;
    let red = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90 && d[i + 3] > 128) red++;
    return { bootMs, renderMs, redPixels: red, components: builtins.size, crossOriginIsolatedAfter: self.crossOriginIsolated };
  } catch (e) {
    return { error: String(e) };
  } finally {
    service.host.dispose();
  }
}

/**
 * 3D 效能（plan-10-30 ⑧）：1280×720，每格送一張下層畫面（模擬 V1），依序畫 120 格；
 * 記第一格（建場景＋編 shader）與之後每格的平均、p95（含畫面轉移與回傳），換算 60 秒區段要多久。
 */
async function check3D(): Promise<Record<string, unknown>> {
  const service = new PluginService();
  const out: Record<string, unknown> = {};
  try {
    const plugins = await builtinPlugins3D();
    // 模擬的下層畫面：彩色漸層（每格不同，避免被快取）
    const src = new OffscreenCanvas(1280, 720);
    const g = src.getContext("2d")!;
    /** 讀回用的 1×1 畫布 */
    const probe = new OffscreenCanvas(1, 1).getContext("2d", { willReadFrequently: true })!;
    for (const id of ["desk-reveal", "board-swing-in", "mascot-point"]) {
      const template = TEMPLATES_3D.find((t) => t.id === id)!;
      const plugin = plugins.get(template.componentId)!;
      const code = String(plugin.component.code);
      const params = Object.fromEntries(Object.entries((plugin.component as { params: Record<string, { default?: unknown }> }).params).map(([k, d]) => [k, d.default]));
      Object.assign(params, template.params);
      const times: number[] = [];
      for (let f = 0; f < 120; f++) {
        const grad = g.createLinearGradient(0, 0, 1280, 720);
        grad.addColorStop(0, `hsl(${(f * 3) % 360}, 80%, 50%)`);
        grad.addColorStop(1, `hsl(${(f * 3 + 180) % 360}, 80%, 50%)`);
        g.fillStyle = grad;
        g.fillRect(0, 0, 1280, 720);
        const bg = src.transferToImageBitmap();
        const t0 = performance.now();
        const bitmap = await service.three.render(`perf-${id}`, code, { frame: f, fps: 30, duration: template.duration, width: 1280, height: 720, videoW: 1280, videoH: 720, params, box: { cx: 0.6, cy: 0.45, w: 0.25, h: 0.25 }, seed: 1 }, bg);
        // 讀回一個像素：逼 GPU 把這一格畫完（WebGL 送出就回來，不讀回量到的只是訊息往返）
        probe.drawImage(bitmap, 0, 0, 1, 1);
        probe.getImageData(0, 0, 1, 1);
        times.push(performance.now() - t0);
        bitmap.close();
      }
      const rest = times.slice(1).sort((a, b) => a - b);
      const mean = rest.reduce((a, b) => a + b, 0) / rest.length;
      out[id] = { firstMs: Math.round(times[0]), meanMs: Number(mean.toFixed(1)), p95Ms: Number(rest[Math.floor(rest.length * 0.95)].toFixed(1)), sixtySecondsSec: Number((mean * 1800 / 1000).toFixed(1)) };
    }
  } catch (e) {
    out.error = String(e);
  } finally {
    service.three.dispose();
  }
  return out;
}

/**
 * MP4 匯出（§5.4）在 WebView2 的關鍵路徑：mediabunny 用 asset 協定的網址（Range）讀原檔、Rust 分塊寫檔（raw body）、
 * 硬體編碼。每支影片取前 30 秒放上 V1＋A1，匯出到 repo 的 output/ 再用 ffprobe 讀回長度；記耗時與即時倍速。
 */
async function checkExport(paths: string[]): Promise<Record<string, unknown>[]> {
  const engine = createEngine();
  const results: Record<string, unknown>[] = [];
  const videos = paths.filter((p) => /\.(mp4|mov)$/i.test(p) && !/alpha/i.test(p));
  for (const [i, path] of videos.entries()) {
    const out: Record<string, unknown> = { path };
    try {
      const media = await engine.probe({ kind: "path", path, name: path.split(/[\\/]/).pop()! }, `x${i}`);
      const { Input, UrlSource, ALL_FORMATS } = await import("mediabunny");
      const input = new Input({ source: new UrlSource(convertFileSrc(path)), formats: ALL_FORMATS });
      out.sourceDuration = await input.computeDuration();
      input.dispose();
      let project: Project = { ...emptyProject(), media: [media] };
      // 放上 V1（有聲音的影片會一併放上對白軌），只取前 30 秒
      project = placeMedia(project, media.id, project.tracks.find((t) => t.kind === "video")!.id, 0);
      project = { ...project, clips: project.clips.map((c) => ({ ...c, srcOut: Math.min(c.srcOut, c.srcIn + 30) })) };
      const plan = exportPlan(project, "source");
      const dest = path.replace(/[\\/](e2e[\\/]fixtures|samples)[\\/][^\\/]+$/i, "") + `\\output\\selftest-export-${i}.mp4`;
      const id = await invoke<number>("export_open", { path: dest });
      const target = {
        name: dest,
        write: (position: number, data: Uint8Array) => invoke<void>("export_write", data, { headers: { "x-export-id": String(id), "x-export-pos": String(position) } }),
        close: () => invoke<void>("export_close", { id }),
        abort: () => invoke<void>("export_abort", { id }),
        writeSibling: async () => "",
      };
      const t0 = performance.now();
      await runExport({
        project, plan, target, effects: null, audioCodec: "aac",
        source: (m) => engine.exportSource(m),
        audio: (audioSource, signal) => mixAudio({ project, duration: plan.duration, source: (m) => engine.exportSource(m), audioSource, signal }),
      });
      const ms = performance.now() - t0;
      // 讀回成品：output/ 不在 asset 協定的範圍內，改用 ffprobe（Rust probe_media）
      const probe = await invoke<{ duration: number; audio: boolean; width?: number; height?: number }>("probe_media", { path: dest });
      Object.assign(out, {
        size: `${plan.width}x${plan.height}`, exportDuration: plan.duration, outputDuration: probe.duration, outputSize: `${probe.width}x${probe.height}`,
        audioTrack: probe.audio, ms: Math.round(ms), realtime: Number((plan.duration / (ms / 1000)).toFixed(2)), dest,
      });
    } catch (e) {
      out.error = String(e);
    }
    results.push(out);
  }
  return results;
}

/** ASR 音訊（§5.2）：每支有聲影片抽 [1, 3) 秒，檢查 WAV 檔頭是 16 kHz 單聲道 16-bit、長度約 2 秒 */
async function checkAsrAudio(paths: string[]): Promise<Record<string, unknown>[]> {
  const engine = createEngine();
  const results: Record<string, unknown>[] = [];
  for (const [i, path] of paths.filter((p) => /\.(mp4|mov|mp3)$/i.test(p) && !/alpha/i.test(p)).entries()) {
    const out: Record<string, unknown> = { path };
    try {
      const media = await engine.probe({ kind: "path", path, name: path.split(/[\\/]/).pop()! }, `asr${i}`);
      const t0 = performance.now();
      const wav = await engine.extractAsrAudio(media, 1, 3);
      const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
      Object.assign(out, {
        ms: Math.round(performance.now() - t0),
        riff: String.fromCharCode(...wav.subarray(0, 4)),
        channels: view.getUint16(22, true), rate: view.getUint32(24, true), bits: view.getUint16(34, true),
        seconds: view.getUint32(40, true) / 2 / view.getUint32(24, true),
      });
    } catch (e) {
      out.error = String(e);
    }
    results.push(out);
  }
  return results;
}

/**
 * 縮圖序列（D39）：每支影片做第 0 層第 0 段（原檔只解關鍵幀）與第 2 層第 0 段（代理檔），
 * 讀回完成標記，並用 asset 協定載入第一張、畫到 canvas 讀像素（確認資料夾有放行、跨來源不會汙染畫布）
 */
async function checkThumbs(paths: string[]): Promise<Record<string, unknown>[]> {
  const engine = createEngine();
  const results: Record<string, unknown>[] = [];
  for (const [i, path] of paths.filter((p) => /\.(mp4|mov)$/i.test(p)).entries()) {
    const out: Record<string, unknown> = { path };
    try {
      let media = await engine.probe({ kind: "path", path, name: path.split(/[\\/]/).pop()! }, `th${i}`);
      const prepared = await engine.prepare(media, () => undefined);
      media = { ...media, proxyPath: prepared.proxyPath };
      let t0 = performance.now();
      await engine.makeThumbs(media, 0, 0);
      out.tier0Ms = Math.round(performance.now() - t0);
      t0 = performance.now();
      await engine.makeThumbs(media, 2, 0);
      out.tier2Ms = Math.round(performance.now() - t0);
      out.done = await engine.thumbStatus(media);
      const url = await engine.thumbUrl(media, 2, 0);
      out.url = url;
      const img = new Image();
      img.crossOrigin = "anonymous";
      await new Promise<void>((ok, fail) => { img.onload = () => ok(); img.onerror = () => fail(new Error("thumbnail did not load")); img.src = url!; });
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let lit = 0;
      for (let k = 0; k < px.length; k += 4) if (px[k] + px[k + 1] + px[k + 2] > 60) lit++;
      Object.assign(out, { width: img.naturalWidth, height: img.naturalHeight, litRatio: Number((lit / (px.length / 4)).toFixed(2)) });
    } catch (e) {
      out.error = String(e);
    }
    results.push(out);
  }
  return results;
}

/**
 * SAM 小檔（§5.3）：在 WebView2 用 mediabunny 把每支影片的前 3 秒轉成每秒 10 格、寬 ≤ 1280 的無聲 MP4，
 * 檢查格數、每格時間與換鏡頭差異都有算出來（不呼叫 SAM）
 */
async function checkSamClip(paths: string[]): Promise<Record<string, unknown>[]> {
  const engine = createEngine();
  const results: Record<string, unknown>[] = [];
  for (const [i, path] of paths.filter((p) => /\.(mp4|mov)$/i.test(p) && !/alpha/i.test(p)).entries()) {
    const out: Record<string, unknown> = { path };
    try {
      const media = await engine.probe({ kind: "path", path, name: path.split(/[\\/]/).pop()! }, `sc${i}`);
      const t0 = performance.now();
      const clip = await makeSamClip(await engine.exportSource(media), 0, Math.min(3, media.duration), { fps: 10, maxWidth: 1280, videoW: media.width ?? 1280, videoH: media.height ?? 720 });
      Object.assign(out, { ms: Math.round(performance.now() - t0), bytes: clip.bytes.length, frames: clip.times.length, width: clip.width, height: clip.height, firstTimes: clip.times.slice(0, 3), maxDiff: Math.round(Math.max(...clip.diffs)) });
    } catch (e) {
      out.error = String(e);
    }
    results.push(out);
  }
  return results;
}

/**
 * AI 導演的小檔速度（docs/plan-10-28-director.md R0）：lecture-a 前 120 秒轉成高 480、每秒 2 格、250 kbps，
 * 原檔與代理檔各量一次（代理檔是 540p，解碼便宜）
 */
async function checkDirectorClip(paths: string[]): Promise<Record<string, unknown>[]> {
  const engine = createEngine();
  const results: Record<string, unknown>[] = [];
  const path = paths.find((p) => /lecture-a/i.test(p));
  if (!path) return results;
  let media = await engine.probe({ kind: "path", path, name: "lecture-a" }, "dir0");
  const prepared = await engine.prepare(media, () => undefined);
  media = { ...media, proxyPath: prepared.proxyPath };
  for (const [label, source] of [["original", await engine.exportSource(media)], ["proxy", media.proxyPath ? convertFileSrc(media.proxyPath) : null]] as const) {
    if (!source) continue;
    const out: Record<string, unknown> = { label };
    try {
      const t0 = performance.now();
      const clip = await makeSamClip(source, 0, 120, { fps: 2, maxWidth: Infinity, maxHeight: 480, bitrate: 250_000, scan: false, videoW: media.width ?? 1920, videoH: media.height ?? 1080 });
      Object.assign(out, { seconds: +((performance.now() - t0) / 1000).toFixed(1), bytes: clip.bytes.length, width: clip.width, height: clip.height });
    } catch (e) {
      out.error = String(e);
    }
    results.push(out);
  }
  return results;
}

/** 螢幕文字定位的取畫面（D40）：lecture-a 的 0 秒、1 秒與片尾，前兩張要有 JPEG，片尾那張記下長度（片尾常取不到） */
async function checkGrabJpegs(paths: string[]): Promise<Record<string, unknown>> {
  const engine = createEngine();
  const path = paths.find((p) => /lecture-a/i.test(p));
  if (!path) return {};
  try {
    const media = await engine.probe({ kind: "path", path, name: "lecture-a" }, "grab0");
    const t0 = performance.now();
    const jpegs = await grabJpegs(await engine.exportSource(media), [0, 1, media.duration]);
    return { ms: Math.round(performance.now() - t0), sizes: jpegs.map((j) => j.length) };
  } catch (e) {
    return { error: String(e) };
  }
}

/**
 * 專案資料夾（D41）：在 repo 的 output\ 建 selftest.wordblade、寫 project.json 再讀回、算素材指紋、
 * 用相對路徑找回素材（模擬搬家：相對路徑對、絕對路徑錯）
 */
async function checkProjectFolder(paths: string[]): Promise<Record<string, unknown>> {
  const talk = paths.find((p) => /talk\.mp4$/i.test(p));
  if (!talk) return {};
  try {
    const root = talk.replace(/[\\/]e2e[\\/]fixtures[\\/]talk\.mp4$/i, "");
    const parent = `${root}\\output`;
    const dir = await invoke<string>("project_create", { parent, name: `selftest-${Date.now()}` });
    await invoke("project_write", { dir, text: JSON.stringify({ hello: 1 }) });
    const [readDir, text] = await invoke<[string, string]>("project_read", { dir });
    const fingerprint = await invoke<string>("media_fingerprint", { path: talk });
    const located = await invoke<string | null>("media_locate", { candidates: ["Z:\\nope\\talk.mp4", talk], fingerprint });
    const wrong = await invoke<string | null>("media_locate", { candidates: [talk], fingerprint: "1:0000000000000000" });
    return { dir: readDir, roundTrip: text === JSON.stringify({ hello: 1 }), fingerprint, located, wrongFingerprint: wrong };
  } catch (e) {
    return { error: String(e) };
  }
}

/** AI 音效／配樂產生的 WAV（§5.15）：寫進 app 資料夾的 generated/、再讀規格，確認匯入流程走得通 */
async function checkGenerated(): Promise<Record<string, unknown>> {
  const engine = createEngine();
  try {
    const samples = new Float32Array(16000).map((_, i) => Math.sin((i / 16000) * 2 * Math.PI * 440) * 0.3);
    const source = await engine.importGenerated("selftest-tone.wav", encodeWav(samples, 16000));
    const media = await engine.probe(source, "gen-selftest");
    return { source: source.kind === "path" ? source.path : source.name, kind: media.kind, duration: Number(media.duration.toFixed(2)), audio: media.audio };
  } catch (e) {
    return { error: String(e) };
  }
}

/** 跑自我檢查：從回報伺服器拿要檢查的檔案清單，逐一檢查後把結果送回去 */
export async function runSelftest(server: string) {
  const report: Record<string, unknown> = { origin: location.origin, userAgent: navigator.userAgent, startedAt: new Date().toISOString() };
  try {
    report.isolation = { crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer };
    report.samplesDir = await invoke("find_samples_dir");
    report.tools = await invoke("media_tools");
    const { paths } = (await (await fetch(`${server}/config`)).json()) as { paths: string[] };
    const files: unknown[] = [];
    for (const [i, path] of paths.entries()) files.push(await checkFile(path, i));
    report.files = files;
    report.sandbox = await checkSandbox();
    report.three = await check3D();
    report.microphone = await checkMicrophone();
    report.export = await checkExport(paths);
    report.asrAudio = await checkAsrAudio(paths);
    report.thumbs = await checkThumbs(paths);
    report.samClip = await checkSamClip(paths);
    report.generated = await checkGenerated();
    report.directorClip = await checkDirectorClip(paths);
    report.grabJpegs = await checkGrabJpegs(paths);
    report.projectFolder = await checkProjectFolder(paths);
  } catch (e) {
    report.error = String(e);
  }
  report.finishedAt = new Date().toISOString();
  await fetch(`${server}/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
}
