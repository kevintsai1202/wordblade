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
  } catch (e) {
    report.error = String(e);
  }
  report.finishedAt = new Date().toISOString();
  await fetch(`${server}/report`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(report) });
}
