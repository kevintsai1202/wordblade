// 模擬「合成器」主頁：建立沙盒 iframe、在裡面建 Worker、以 ImageBitmap 雙向轉移，並提供給 Playwright 呼叫的測試函式。
// 所有測試函式掛在 window.t 底下，回傳可序列化的結果物件。
const W = 1920;
const H = 1080;

// 父頁的「機密」：沙盒 iframe 不應該拿得到（反向檢查用）
document.cookie = 'secret=parent-cookie; path=/';
try { localStorage.setItem('secret', 'parent-localStorage'); } catch (e) { /* 忽略 */ }
window.__secret = 'parent-global';

/** 抓文字檔（同源，父頁 CSP connect-src 'self' 放行）。 */
async function fetchText(url) { return (await fetch(url)).text(); }
/** 快取：前置腳本、harness、探針、iframe 執行環境的原始碼。 */
const SRC = {};
async function loadSources() {
  if (SRC.prelude) return;
  [SRC.prelude, SRC.harness, SRC.probes, SRC.runtime] = await Promise.all([
    fetchText('/worker-prelude.js'), fetchText('/worker-harness.js'), fetchText('/probes.js'), fetchText('/iframe-runtime.js'),
  ]);
}

/** 計算文字的 CSP sha256 來源表達式。 */
async function cspHash(text) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(d)))}'`;
}

/**
 * 沙盒宿主：父頁這一側管理 iframe、控制通道與 Worker 資料通道。
 */
class SandboxHost {
  constructor() {
    this.waiters = [];
    this.errors = [];
    this.nextId = 1;
  }

  /**
   * 建立沙盒 iframe 並等它啟動。
   * @param {{variant:'nonce'|'hash'|'blob', csp:'spec'|'hardened', relay?:boolean, lockdown?:boolean}} o
   *   variant：啟動腳本怎麼通過 CSP；csp：iframe 自己的 CSP（spec＝spec §5.7 原文，hardened＝再加幾條）
   */
  static async create(o) {
    await loadSources();
    const h = new SandboxHost();
    h.opts = o;
    const nonce = document.querySelector('meta[name=nonce]').content;
    let bootSrc, scriptTag;
    if (o.variant === 'nonce') { bootSrc = `'nonce-${nonce}'`; scriptTag = `<script nonce="${nonce}">${SRC.runtime}</script>`; }
    else if (o.variant === 'hash') { bootSrc = await cspHash(SRC.runtime); scriptTag = `<script>${SRC.runtime}</script>`; }
    else { bootSrc = ''; scriptTag = `<script src="${URL.createObjectURL(new Blob([SRC.runtime], { type: 'text/javascript' }))}"></script>`; }
    let csp = `default-src 'none'; script-src blob: ${bootSrc}; worker-src blob:; connect-src 'none'; img-src blob: data:`;
    if (o.csp === 'hardened') csp += "; frame-src 'none'; base-uri 'none'; form-action 'none'";
    h.csp = csp;
    // extraInline：另外塞一段帶 nonce 的 inline script 進 srcdoc（退路的另一種寫法：插件程式直接內嵌，父頁不必放行 blob:）
    if (o.extraInline && o.variant === 'nonce') scriptTag += `<script nonce="${nonce}">${o.extraInline}</script>`;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}"></head><body>${scriptTag}</body></html>`;
    h.iframe = iframe;
    const t0 = performance.now();
    const boot = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('iframe 3 秒內沒有 boot（CSP 擋掉啟動腳本？）')), 3000);
      const onMsg = (e) => {
        if (e.source === iframe.contentWindow && e.data && e.data.type === 'boot') {
          window.removeEventListener('message', onMsg); clearTimeout(timer); resolve();
        }
      };
      window.addEventListener('message', onMsg);
    });
    h.inlineRan = false;
    window.addEventListener('message', (e) => { if (e.source === iframe.contentWindow && e.data && e.data.type === 'inline-ran') h.inlineRan = true; });
    document.getElementById('host').appendChild(iframe);
    await boot;
    await new Promise((r) => setTimeout(r, 100));
    const mc = new MessageChannel();
    h.ctrl = mc.port1;
    h.ctrl.onmessage = (e) => h._dispatch(e.data);
    iframe.contentWindow.postMessage({ type: 'init', port: mc.port2 }, '*', [mc.port2]);
    await h.waitFor((d) => d.type === 'ready', 3000);
    h.bootMs = performance.now() - t0;
    if (o.lockdown !== false) await h.lockdown();
    return h;
  }

  /** 收到任何訊息時，叫醒符合條件的等待者；錯誤類訊息另外存起來。 */
  _dispatch(d) {
    if (d.type === 'worker-error' || d.type === 'main-error') this.errors.push(d);
    for (const w of [...this.waiters]) {
      if (w.pred(d)) { clearTimeout(w.timer); this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(d); }
    }
  }

  /** 等一則符合條件的訊息；逾時 reject。 */
  waitFor(pred, ms) {
    return new Promise((resolve, reject) => {
      const w = { pred, resolve };
      w.timer = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error('等待逾時 ' + ms + 'ms')); }, ms);
      this.waiters.push(w);
    });
  }

  /** 要 iframe 刪掉 WebRTC 建構子。 */
  async lockdown() {
    const id = this.nextId++;
    const p = this.waitFor((d) => d.type === 'locked' && d.id === id, 3000);
    this.ctrl.postMessage({ cmd: 'lockdown', id });
    await p;
  }

  /**
   * 在 iframe 裡建 Worker 並初始化插件。
   * @param {string} pluginSrc 插件原始碼
   * @returns {Promise<{info:object, setupMs:number}>} info 為插件 init 的回傳（含 WebGL renderer）
   */
  async startWorker(pluginSrc) {
    const source = SRC.prelude + '\n' + SRC.probes + '\n' + pluginSrc + '\n' + SRC.harness;
    const t0 = performance.now();
    const p = this.waitFor((d) => d.type === 'worker-port', 3000);
    this.ctrl.postMessage({ cmd: 'start-worker', source, mode: this.opts.relay ? 'relay' : 'direct' });
    const wp = await p;
    this.wport = wp.port;
    this.wport.onmessage = (e) => this._dispatch(e.data);
    await this.request({ type: 'ping' }, [], 15000); // 訊息會排隊到 worker 腳本載入完成，所以 ping 的回覆時間＝腳本載入＋解析時間
    const t1 = performance.now();
    const ready = await this.request({ type: 'init', width: W, height: H }, [], 30000);
    const t2 = performance.now();
    return { info: ready.info, setupMs: t2 - t0, scriptLoadMs: t1 - t0, initMs: t2 - t1 };
  }

  /** 送一則訊息給 Worker 並等同一個 id 的回覆（init 的回覆是 ready，沒有 id，所以也接受 ready）。 */
  request(msg, transfer = [], ms = 5000) {
    const id = this.nextId++;
    msg.id = id;
    const p = this.waitFor((d) => d.id === id || (msg.type === 'init' && d.type === 'ready'), ms);
    this.wport.postMessage(msg, transfer);
    return p.then((d) => { if (d.type === 'error') throw new Error(d.message); return d; });
  }

  /** 送一格進去、取回一格。 */
  render(t, bitmap, ms = 5000) { return this.request({ type: 'render', t, bitmap }, [bitmap], ms); }

  /** 在 iframe 主執行緒以 blob: script 跑一段程式，回傳它用 __report 報的結果。 */
  async runMain(code, vars = {}, ms = 8000) {
    const id = this.nextId++;
    const source = SRC.prelude + '\n' + SRC.probes + `\nglobalThis.__vars = ${JSON.stringify(vars)};\n(async () => {\n` + code + '\n})();';
    const p = this.waitFor((d) => (d.type === 'main-result' || d.type === 'main-error') && d.id === id, ms);
    this.ctrl.postMessage({ cmd: 'run-main', id, source });
    const d = await p;
    if (d.type === 'main-error') throw new Error(d.message);
    return d.result;
  }

  /** worker.terminate()（由 iframe 執行）。 */
  async kill(ms = 3000) {
    const id = this.nextId++;
    const p = this.waitFor((d) => d.type === 'killed' && d.id === id, ms);
    this.ctrl.postMessage({ cmd: 'kill-worker', id });
    await p;
  }

  /** 移除 iframe。 */
  destroy() { this.iframe.remove(); }
}

// ---------- 合成器端的 WebGL（把 Worker 回傳的 ImageBitmap 畫上去、讀回驗證） ----------
/** 建立主頁的 WebGL2 canvas 與「把貼圖原樣貼滿畫面」的程式。 */
function createMainGL() {
  const canvas = document.getElementById('main');
  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: true });
  const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); return s; };
  const prog = gl.createProgram();
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, `#version 300 es
    void main(){ vec2 p = vec2((gl_VertexID<<1)&2, gl_VertexID&2); gl_Position = vec4(p*2.0-1.0, 0, 1); }`));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, `#version 300 es
    precision highp float; uniform sampler2D u_tex; uniform vec2 u_res; out vec4 o;
    void main(){ vec2 p = gl_FragCoord.xy; o = texture(u_tex, vec2(p.x/u_res.x, 1.0 - p.y/u_res.y)); }`));
  gl.linkProgram(prog);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.useProgram(prog);
  gl.uniform2f(gl.getUniformLocation(prog, 'u_res'), W, H);
  gl.viewport(0, 0, W, H);
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  const renderer = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  /** 把 ImageBitmap 貼滿主 canvas。 */
  function draw(bitmap) {
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
  const one = new Uint8Array(4);
  /** 讀回一個畫素（座標以影像左上為原點）；readPixels 會強迫 GPU 完成，所以也是同步點。 */
  function px(x, yTop) { gl.readPixels(x, H - 1 - yTop, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one); return [one[0], one[1], one[2], one[3]]; }
  const full = new Uint8Array(W * H * 4);
  /** 讀回整張 1920x1080（模擬「GPU 讀回整格」的成本）。 */
  function readFull() { gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, full); return full; }
  return { gl, draw, px, readFull, renderer };
}

/** 取樣雜湊（驗證兩次輸出位元相同）：每隔 7 個位元組取一個做 FNV-1a。 */
function hash32(u8) { let h = 0x811c9dc5; for (let i = 0; i < u8.length; i += 7) { h ^= u8[i]; h = Math.imul(h, 16777619); } return h >>> 0; }
/** 百分位數（nearest-rank）。 */
function pct(arr, p) { const s = [...arr].sort((a, b) => a - b); return s[Math.max(0, Math.ceil(p * s.length) - 1)]; }
/** 平均。 */
function mean(arr) { return arr.reduce((a, b) => a + b, 0) / arr.length; }
/** 統計摘要（毫秒，三位小數）。 */
function stat(arr) { const r = (x) => Math.round(x * 1000) / 1000; return { mean: r(mean(arr)), p50: r(pct(arr, 0.5)), p95: r(pct(arr, 0.95)), max: r(Math.max(...arr)) }; }

/** 輸入畫面：左半依格號變色、右半固定色、左上角 64x64 白色標記（用來偵測上下左右翻轉）。 */
function drawInput(ctx, f) {
  ctx.fillStyle = `rgb(${f % 200},${(f * 7) % 200},${(f * 13) % 200})`; ctx.fillRect(0, 0, W / 2, H);
  ctx.fillStyle = 'rgb(10,20,30)'; ctx.fillRect(W / 2, 0, W / 2, H);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 64, 64);
}
/** gl-invert 插件對第 f 格的預期輸出；回傳 [名稱, x, yTop, [r,g,b,a]] 清單。 */
function expectedGlInvert(f) {
  const c = [f % 200, (f * 7) % 200, (f * 13) % 200];
  const inv = c.map((v) => 255 - v).concat(255);
  return [['topLeftMarker', 10, 10, [0, 0, 0, 255]], ['left', 200, 500, inv], ['leftBottom', 100, 1000, inv],
    ['right', 1500, 500, [245, 235, 225, 255]], ['greenBR', 1900, 1070, [0, 255, 0, 255]], ['band', 950, 500, [0, 0, 0, 0]]];
}
/** 比對畫素（容許 ±tol），回傳不符的描述；相符回 null。 */
function diffPx(got, want, tol = 2) { return got.every((v, i) => Math.abs(v - want[i]) <= tol) ? null : { got, want }; }

const hosts = {};
let mainGL = null;

window.t = {
  /** 環境資訊：UA、主頁 WebGL renderer。 */
  env() { mainGL = mainGL || createMainGL(); return { ua: navigator.userAgent, mainRenderer: mainGL.renderer, crossOriginIsolated: self.crossOriginIsolated, hwConcurrency: navigator.hardwareConcurrency }; },

  /** 建立宿主並存起來。 */
  async open(name, o) {
    try {
      const h = await SandboxHost.create(o);
      hosts[name] = h;
      return { ok: true, bootMs: Math.round(h.bootMs), csp: h.csp, inlineRan: h.inlineRan };
    } catch (e) { return { ok: false, error: String(e.message) }; }
  },
  /** 在宿主裡啟動插件（'gl'｜'three'｜'hang'）。 */
  async plugin(name, which) {
    const src = await fetchText(which === 'gl' ? '/plugins/gl-invert.js' : which === 'hang' ? '/plugins/hang.js' : '/dist/three-box.js');
    try { const r = await hosts[name].startWorker(src); return { ok: true, ...r, errors: hosts[name].errors }; }
    catch (e) { return { ok: false, error: String(e.message), errors: hosts[name].errors }; }
  },
  /** 只殺 Worker（不重建）。 */
  async kill(name) { await hosts[name].kill(); },
  /** 關掉宿主。 */
  close(name) { if (hosts[name]) hosts[name].destroy(); delete hosts[name]; },

  /**
   * 來回測試：連續 frames 格，每格 ImageBitmap 進 → Worker 畫 → ImageBitmap 出 → 主頁 WebGL 上傳 → readPixels 驗證。
   * @param {string} name 宿主名稱（要先 open＋plugin('gl')）
   * @param {{frames:number, warmup:number, fullReadback:boolean}} o
   */
  async bench(name, o) {
    mainGL = mainGL || createMainGL();
    const h = hosts[name];
    const inCanvas = new OffscreenCanvas(W, H);
    const ictx = inCanvas.getContext('2d');
    const tCreate = [], tRound = [], tUpload = [], tRead = [], tTotal = [], tNoCreate = [];
    let mismatches = 0; const samples = [];
    for (let f = 0; f < o.warmup + o.frames; f++) {
      const t0 = performance.now();
      drawInput(ictx, f);
      const bmp = await createImageBitmap(inCanvas);
      const t1 = performance.now();
      const r = await h.render(f / 30, bmp);
      const t2 = performance.now();
      mainGL.draw(r.bitmap);
      const t3 = performance.now();
      let bad = null;
      for (const [nm, x, y, want] of expectedGlInvert(f)) { const d = diffPx(mainGL.px(x, y), want); if (d) bad = { nm, ...d }; }
      if (o.fullReadback) mainGL.readFull();
      const t4 = performance.now();
      r.bitmap.close();
      if (f >= o.warmup) {
        tCreate.push(t1 - t0); tRound.push(t2 - t1); tUpload.push(t3 - t2); tRead.push(t4 - t3); tTotal.push(t4 - t0); tNoCreate.push(t4 - t1);
        if (bad) { mismatches++; if (samples.length < 3) samples.push({ f, ...bad }); }
      }
    }
    return {
      frames: o.frames, fullReadback: o.fullReadback, relay: !!h.opts.relay, mismatches, samples,
      createImageBitmap: stat(tCreate), sendToWorkerAndBack: stat(tRound), mainUploadDraw: stat(tUpload), readback: stat(tRead),
      roundTripTotalExclCreate: stat(tNoCreate), perFrameTotal: stat(tTotal),
    };
  },

  /** 確定性：同一格算兩次，整張讀回比雜湊。 */
  async determinism(name) {
    mainGL = mainGL || createMainGL();
    const h = hosts[name];
    const inCanvas = new OffscreenCanvas(W, H); const ictx = inCanvas.getContext('2d');
    const hashes = [];
    for (let i = 0; i < 2; i++) {
      drawInput(ictx, 5);
      const r = await h.render(5 / 30, await createImageBitmap(inCanvas));
      mainGL.draw(r.bitmap); r.bitmap.close();
      hashes.push(hash32(mainGL.readFull()));
    }
    return { hashes, equal: hashes[0] === hashes[1] };
  },

  /** three.js 插件：疊加物件（透明背景）＋當格畫面當貼圖。驗證角落透明、中央貼圖顏色正確，並量每格耗時。 */
  async threeFrames(name, frames) {
    mainGL = mainGL || createMainGL();
    const h = hosts[name];
    const inCanvas = new OffscreenCanvas(W, H); const ictx = inCanvas.getContext('2d');
    const tt = []; let bad = 0; const samples = [];
    for (let f = 0; f < frames + 5; f++) {
      drawInput(ictx, f);
      const bmp = await createImageBitmap(inCanvas);
      const t0 = performance.now();
      const r = await h.render(0, bmp, 10000); // t=0：平面正對鏡頭
      mainGL.draw(r.bitmap); r.bitmap.close();
      const corner = mainGL.px(5, 5), center = mainGL.px(700, 540);
      const t1 = performance.now();
      const c = [f % 200, (f * 7) % 200, (f * 13) % 200, 255];
      const errs = [];
      if (corner[3] !== 0) errs.push({ corner });
      if (diffPx(center, c, 3)) errs.push({ center, want: c });
      if (f >= 5) { tt.push(t1 - t0); if (errs.length) { bad++; if (samples.length < 3) samples.push({ f, errs }); } }
    }
    return { frames, mismatches: bad, samples, roundTripWithReadback: stat(tt) };
  },

  /** Worker 內的探針（網路／eval 等）。 */
  async probeWorker(name, vars) { return hosts[name].request({ type: 'probe', vars }, [], 20000).then((d) => d.result); },
  /** iframe 主執行緒的探針（網路類）。 */
  async probeMain(name, vars) { return hosts[name].runMain('__report(await __probes(__vars));', vars, 20000); },
  /** iframe 主執行緒的 WebRTC 探針。 */
  async probeRtc(name, vars) { return hosts[name].runMain('__report(await __probeRtc(__vars));', vars, 20000); },
  /** iframe 主執行緒：拿得到 parent 的東西嗎。 */
  async probeParent(name) { return hosts[name].runMain('__report(await __probeParent());', {}, 20000); },
  /** Worker 內的時間與亂數（t 秒）。 */
  async clock(name, tSec) { return hosts[name].request({ type: 'clock', t: tSec }).then((d) => d.result); },
  /** iframe 主執行緒的時間與亂數。 */
  async clockMain(name, tSec) {
    return hosts[name].runMain(`__clock.ms=${tSec * 1000}; __reseed(7); __report({dateNow:Date.now(), newDate:+new Date(), perfNow:performance.now(), rand:[Math.random(),Math.random(),Math.random()]});`);
  },
  /** 要 Worker 無窮迴圈（不等回覆）。 */
  hangWorker(name) { hosts[name].wport.postMessage({ type: 'hang' }); return performance.now(); },
  /** 逾時處理：照 3D 預算 budgetMs 等回覆，沒回就 kill → 重建 Worker → 再畫一格驗證。 */
  async timeoutRecover(name, budgetMs) {
    const h = hosts[name];
    mainGL = mainGL || createMainGL();
    const inCanvas = new OffscreenCanvas(W, H); const ictx = inCanvas.getContext('2d'); drawInput(ictx, 1);
    const bmp = await createImageBitmap(inCanvas);
    const t0 = performance.now();
    let timedOut = false;
    try { await h.render(0, bmp, budgetMs); } catch (e) { timedOut = true; }
    const tDetect = performance.now();
    await h.kill();
    const tKilled = performance.now();
    const src = await fetchText('/plugins/gl-invert.js');
    const st = await h.startWorker(src);
    const tRebuilt = performance.now();
    drawInput(ictx, 3);
    const r = await h.render(0, await createImageBitmap(inCanvas));
    mainGL.draw(r.bitmap); r.bitmap.close();
    const bad = expectedGlInvert(3).map(([n, x, y, w]) => diffPx(mainGL.px(x, y), w)).filter(Boolean);
    const tFrame = performance.now();
    return { timedOut, detectMs: Math.round(tDetect - t0), killMs: Math.round((tKilled - tDetect) * 10) / 10, rebuildMs: Math.round(tRebuilt - tKilled), firstFrameAfterMs: Math.round(tFrame - tRebuilt), pixelsOk: bad.length === 0, renderer: st.info.renderer };
  },
  /** 心跳：主頁每 20ms 記一次時間，用來看有沒有被卡住。 */
  startHeartbeat() { window.__hb = []; window.__hbTimer = setInterval(() => window.__hb.push(performance.now()), 20); },
  /** 讀心跳：回傳最大間隔。 */
  heartbeat() { const a = window.__hb; let max = 0; for (let i = 1; i < a.length; i++) max = Math.max(max, a[i] - a[i - 1]); return { n: a.length, maxGapMs: Math.round(max), sinceLastMs: Math.round(performance.now() - a[a.length - 1]) }; },
  /** 要 iframe 主執行緒無窮迴圈（不等回覆）。 */
  hangMain(name) { hosts[name].ctrl.postMessage({ cmd: 'run-main', id: 9999, source: 'while(true){}' }); },
  /** 反覆「建 Worker＋WebGL2 → terminate」n 次，確認不會累積 context／資源，最後一次仍能正確畫格。 */
  async churn(name, n) {
    const src = await fetchText('/plugins/gl-invert.js');
    const times = [];
    for (let i = 0; i < n; i++) { const t0 = performance.now(); await hosts[name].startWorker(src); times.push(performance.now() - t0); await hosts[name].kill(); }
    await hosts[name].startWorker(src);
    const b = await this.bench(name, { frames: 3, warmup: 0, fullReadback: false });
    return { n, startMs: stat(times), finalMismatches: b.mismatches, hostErrors: hosts[name].errors.length };
  },
  /** 移除 iframe 後再建一個新的並驗證可用。 */
  async removeAndRebuild(name, o) {
    const t0 = performance.now();
    hosts[name].destroy(); delete hosts[name];
    const tRemoved = performance.now();
    const r = await this.open(name + '2', o);
    const p = r.ok ? await this.plugin(name + '2', 'gl') : null;
    return { removeMs: Math.round((tRemoved - t0) * 10) / 10, rebuildOk: !!(r.ok && p && p.ok), totalMs: Math.round(performance.now() - t0) };
  },
  /** 從 iframe 主執行緒讓 iframe 自己導航到外部網址（測 frame-src／navigation 外洩）。 */
  async navigateSelf(name, url) {
    hosts[name].ctrl.postMessage({ cmd: 'run-main', id: 7, source: `location.href = ${JSON.stringify(url)};` });
    await new Promise((r) => setTimeout(r, 1500));
    return { done: true };
  },
};
window.__ready = true;
