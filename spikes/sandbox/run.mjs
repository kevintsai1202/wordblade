// 沙盒實測的 Playwright 驅動腳本。
// 用法（PowerShell 7）：
//   node run.mjs                              # 三個環境全跑
//   node run.mjs --env=chromium-headed        # 只跑指定環境（逗號分隔）
// 環境：chromium-headed（預設 Chromium、有視窗）、msedge-headed（channel: msedge，WebView2 的近似）、chromium-headless（對照用）。
// 結果寫到 results/<環境>.json，同時把摘要印在 stdout。
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServers } from './server.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** 要測的環境定義。 */
const ENVS = {
  'chromium-headed': { launch: { headless: false } },
  'msedge-headed': { launch: { channel: 'msedge', headless: false } },
  'chromium-headless': { launch: { headless: true } },
  // 對照：關掉「沙盒 iframe 獨立行程」，模擬 WebView2 或低記憶體設定下沒有行程隔離的情況，只跑退路（iframe 主執行緒無窮迴圈）那一段
  'chromium-noisolate': { launch: { headless: false, args: ['--disable-features=IsolateSandboxedIframes'] }, onlyFallback: true },
};

const FRAMES = Number(process.env.FRAMES || 300);
const WARMUP = 20;

/** 幫 promise 加逾時；逾時 reject（用來偵測「主頁被卡住」）。 */
function withTimeout(p, ms, label) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`逾時 ${ms}ms：${label}`)), ms))]);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 誘餌伺服器記錄的快照。 */
const snap = (s) => ({ http: [...s.hits.http], ws: [...s.hits.ws], udp: s.hits.udp });
/** 等 400ms 讓還在路上的請求（例如 sendBeacon）到齊，再取快照。 */
const settled = async (s) => { await sleep(400); return snap(s); };
/** 兩個快照之間新增的請求。 */
const delta = (a, b) => ({ http: b.http.slice(a.http.length), ws: b.ws.slice(a.ws.length), udp: b.udp - a.udp });
/** 這個探針在誘餌上留下的請求數（以 k= 或路徑關鍵字判斷）。 */
function hitsFor(d, key) {
  if (key === 'ws') return d.ws.length;
  return d.http.filter((u) => u.includes('k=' + key) || u.includes(key)).length;
}
/** 探針名稱 → 誘餌上的關鍵字。 */
const PROBE_KEY = {
  fetch: 'fetch', xhr: 'xhr', websocket: 'ws', eventsource: 'sse', dynamicImport: 'hit-k-import', importScriptsExternal: 'importScripts',
  sendBeacon: 'beacon', imgBeacon: 'img', windowOpen: 'open',
};
/** 這些探針「預期被擋」；沒有例外。 */
const EXPECT_ALLOWED = new Set();

/**
 * 把一組探針結果和誘餌記錄合在一起，判定通過／失敗。
 * @param {object} probes 探針結果
 * @param {object} d 這組探針期間誘餌新增的請求
 */
function judge(probes, d) {
  const rows = {};
  for (const [name, r] of Object.entries(probes)) {
    const key = PROBE_KEY[name];
    const hits = key ? hitsFor(d, key) : null;
    const expectBlocked = !EXPECT_ALLOWED.has(name);
    // 有誘餌關鍵字的探針，以「誘餌真的沒收到」為準（sendBeacon 會回傳 true 但請求其實被 CSP 擋下）
    const pass = key ? !hits && (r.blocked || name === 'sendBeacon') : (expectBlocked ? r.blocked : !r.blocked);
    rows[name] = { pass, blocked: r.blocked, decoyHits: hits, detail: r.detail };
  }
  return rows;
}

/** 跑一個環境的全部測試，回傳結果物件。 */
async function runEnv(envId, servers, cdpWorkerTargets) {
  const R = { env: envId, steps: {} };
  const browser = await chromium.launch(ENVS[envId].launch);
  R.browserVersion = browser.version();
  const cdp = await browser.newBrowserCDPSession();
  /** 目前所有「專用 worker」的 CDP target。 */
  const workerTargets = async () => {
    const { targetInfos } = await cdp.send('Target.getTargets');
    return targetInfos.filter((t) => t.type === 'worker').map((t) => ({ id: t.targetId, url: t.url.slice(0, 40) }));
  };
  const allTargets = async () => (await cdp.send('Target.getTargets')).targetInfos.map((t) => t.type);

  /** 開一個新頁面並收集 console 的 CSP 違規訊息。 */
  async function newPage(variant, pblob = false, pframe = false) {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.violations = [];
    page.on('console', (m) => { const t = m.text(); if (/Content Security Policy|Refused to|violates/i.test(t)) page.violations.push(t.slice(0, 200)); });
    page.on('pageerror', (e) => page.violations.push('pageerror: ' + String(e).slice(0, 200)));
    await page.goto(`${servers.mainOrigin}/main.html?variant=${variant}${pblob ? '&pblob=1' : ''}${pframe ? '&pframe=1' : ''}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 10000 });
    return page;
  }
  const ev = (page, fn, arg, ms = 30000) => withTimeout(page.evaluate(fn, arg), ms, String(fn).slice(0, 60));
  /** 開宿主；失敗就丟出錯誤（附原因），避免後面一串連鎖錯誤。 */
  const openHost = async (page, name, o) => { const r = await ev(page, (a) => window.t.open(a.n, a.o), { n: name, o }); if (!r.ok) throw new Error(`open ${name} ${JSON.stringify(o)} 失敗：${r.error}｜${page.violations.slice(0, 3).join(' / ')}`); return r; };

  // ---------- 0. 環境資訊 ----------
  let page = await newPage('nonce');
  R.env_info = await ev(page, () => window.t.env());
  const vars = { http: servers.decoyOrigin, ws: servers.decoyOrigin.replace('http', 'ws'), stunPort: servers.udpPort };

  // ---------- 1. 啟動腳本變體 × CSP 寫法（smoke：iframe 能 boot、Worker 能建、WebGL2 畫得出一格） ----------
  R.steps.variants = {};
  for (const [variant, csp] of [['nonce', 'spec'], ['nonce', 'hardened'], ['hash', 'spec'], ['blob', 'spec']]) {
    const p = variant === 'nonce' ? page : await newPage(variant);
    p.violations.length = 0;
    const o = await ev(p, (a) => window.t.open('smoke', a), { variant, csp });
    let pl = null; let b = null;
    if (o.ok) {
      pl = await ev(p, () => window.t.plugin('smoke', 'gl'));
      if (pl.ok) b = await ev(p, () => window.t.bench('smoke', { frames: 3, warmup: 0, fullReadback: false }));
    }
    R.steps.variants[`${variant}/${csp}`] = { open: o, plugin: pl && { ok: pl.ok, error: pl.error, renderer: pl.info && pl.info.renderer, errors: pl.errors }, pixelMismatches: b && b.mismatches, violations: p.violations.slice(0, 4) };
    await ev(p, () => window.t.close('smoke'));
    if (p !== page) await p.context().close();
  }

  // 退路的另一種寫法：插件程式以帶 nonce 的 inline script 內嵌在 srcdoc（父頁不放行 blob: 也能跑）
  R.steps.inlineMainScript = await ev(page, () => window.t.open('inl', { variant: 'nonce', csp: 'spec', extraInline: "parent.postMessage({type:'inline-ran'},'*')" }));
  await ev(page, () => window.t.close('inl'));
  // 之後都用 nonce / spec（spec §5.7 的寫法）；若它不通過就沒必要往下測
  const primary = R.steps.variants['nonce/spec'];
  if (!primary.open.ok || !(primary.plugin && primary.plugin.ok)) { R.fatal = 'nonce/spec 起不來，後續測試略過'; await browser.close(); return R; }
  const O = { variant: 'nonce', csp: 'spec' };
  // pageB：父頁額外放行 script-src blob:，只給「iframe 主執行緒以 blob: 載入程式」的測試用（Worker 路線不需要）
  const pageB = await newPage('nonce', true);

  if (!ENVS[envId].onlyFallback) {
  // ---------- 2. ImageBitmap 雙向轉移與耗時 ----------
  R.steps.bench = {};
  await openHost(page, 'b', O);
  const pl = await ev(page, () => window.t.plugin('b', 'gl'));
  R.steps.bench.workerGl = pl.info; R.steps.bench.setupMs = Math.round(pl.setupMs); R.steps.bench.scriptLoadMs = Math.round(pl.scriptLoadMs); R.steps.bench.initMs = Math.round(pl.initMs);
  R.steps.bench.directSmallReadback = await ev(page, (a) => window.t.bench('b', a), { frames: FRAMES, warmup: WARMUP, fullReadback: false }, 120000);
  R.steps.bench.directFullReadback = await ev(page, (a) => window.t.bench('b', a), { frames: FRAMES, warmup: WARMUP, fullReadback: true }, 120000);
  R.steps.bench.determinism = await ev(page, () => window.t.determinism('b'));
  await ev(page, () => window.t.close('b'));
  await openHost(page, 'r', { ...O, relay: true });
  await ev(page, () => window.t.plugin('r', 'gl'));
  R.steps.bench.relayFullReadback = await ev(page, (a) => window.t.bench('r', a), { frames: FRAMES, warmup: WARMUP, fullReadback: true }, 120000);
  await ev(page, () => window.t.close('r'));

  // ---------- 2b. three.js（本機打包）在 Worker 裡；重複建 3 次看冷／熱啟動 ----------
  R.steps.three = { startups: [] };
  for (let i = 0; i < 3; i++) {
    await openHost(page, 'three', O);
    const tp = await ev(page, () => window.t.plugin('three', 'three'), null, 60000);
    R.steps.three.startups.push({ ok: tp.ok, error: tp.error, setupMs: tp.setupMs && Math.round(tp.setupMs), scriptLoadMs: tp.scriptLoadMs && Math.round(tp.scriptLoadMs), initMs: tp.initMs && Math.round(tp.initMs), errors: tp.errors });
    if (i === 0) R.steps.three.info = tp.info;
    if (i === 2 && tp.ok) R.steps.three.frames = await ev(page, () => window.t.threeFrames('three', 60), null, 120000);
    await ev(page, () => window.t.close('three'));
  }

  // ---------- 3. 反向檢查 ----------
  R.steps.reverse = {};
  // 3.0 對照組：沒有沙盒也沒有 CSP 的頁面，證明誘餌伺服器真的收得到（否則「沒收到」沒有意義）
  const ctl = await (await browser.newContext()).newPage();
  await ctl.goto(`${servers.decoyOrigin}/blank`);
  const probesSrc = fs.readFileSync(path.join(ROOT, 'public/probes.js'), 'utf8');
  await ctl.addScriptTag({ content: probesSrc });
  let s0 = snap(servers);
  const ctlProbes = await ctl.evaluate((v) => globalThis.__probes(v), vars);
  const ctlHits = delta(s0, await settled(servers));
  R.steps.reverse.control = { reached: Object.fromEntries(Object.entries(PROBE_KEY).map(([n, k]) => [n, hitsFor(ctlHits, k)])), blockedFlags: Object.fromEntries(Object.entries(ctlProbes).map(([n, r]) => [n, r.blocked])) };
  // 對照組的 Worker 版（importScripts 只有 Worker 有）
  s0 = snap(servers);
  const ctlW = await ctl.evaluate(async (a) => {
    const w = new Worker(URL.createObjectURL(new Blob([a.src + '\nonmessage = async (e) => postMessage(await __probes(e.data));'], { type: 'text/javascript' })));
    return new Promise((r) => { w.onmessage = (e) => r(e.data); w.postMessage(a.vars); });
  }, { src: probesSrc, vars });
  const ctlWHits = delta(s0, await settled(servers));
  R.steps.reverse.control.worker = { reached: Object.fromEntries(Object.entries(PROBE_KEY).map(([n, k]) => [n, hitsFor(ctlWHits, k)])), blockedFlags: Object.fromEntries(Object.entries(ctlW).map(([n, r]) => [n, r.blocked])) };
  s0 = snap(servers);
  const ctlRtc = await ctl.evaluate((v) => globalThis.__probeRtc(v), vars);
  R.steps.reverse.control.rtc = { result: ctlRtc, udpPackets: delta(s0, await settled(servers)).udp };
  await ctl.context().close();

  for (const csp of ['spec', 'hardened']) {
    const out = {};
    const name = 'rv-' + csp;
    await openHost(page, name, { ...O, csp });
    await ev(page, (n) => window.t.plugin(n, 'gl'), name);
    // Worker 內
    s0 = snap(servers);
    const wp = await ev(page, (a) => window.t.probeWorker(a[0], a[1]), [name, vars]);
    out.worker = judge(wp, delta(s0, await settled(servers)));
    // 父頁放行 blob: 時（pageB），Worker 的 importScripts(blob:) 會不會通（對照 spec 的 script-src blob:）
    if (csp === 'spec') {
      await openHost(pageB, name + '-w', { ...O, csp });
      await ev(pageB, (n) => window.t.plugin(n, 'gl'), name + '-w');
      const wpB = await ev(pageB, (a) => window.t.probeWorker(a[0], a[1]), [name + '-w', vars]);
      out.workerWhenParentAllowsBlobScript = { importScriptsBlobControl: wpB.importScriptsBlobControl };
      await ev(pageB, (n) => window.t.close(n), name + '-w');
    }
    // iframe 主執行緒
    await openHost(pageB, name, { ...O, csp });
    s0 = snap(servers);
    const mp = await ev(pageB, (a) => window.t.probeMain(a[0], a[1]), [name, vars]);
    out.iframeMain = judge(mp, delta(s0, await settled(servers)));
    // WebRTC（已 lockdown）
    s0 = snap(servers);
    const rtc = await ev(pageB, (a) => window.t.probeRtc(a[0], a[1]), [name, vars]);
    out.rtcAfterLockdown = { result: rtc, udpPackets: delta(s0, await settled(servers)).udp };
    // parent 存取
    out.parentAccess = await ev(pageB, (n) => window.t.probeParent(n), name);
    await ev(page, (n) => window.t.close(n), name); await ev(pageB, (n) => window.t.close(n), name);
    // 未 lockdown 的 WebRTC 對照（證明 CSP 擋不住 WebRTC，所以才需要刪建構子）
    await openHost(pageB, name + '-nolock', { ...O, csp, lockdown: false });
    s0 = snap(servers);
    const rtc2 = await ev(pageB, (a) => window.t.probeRtc(a[0], a[1]), [name + '-nolock', vars]);
    out.rtcWithoutLockdown = { result: rtc2, udpPackets: delta(s0, await settled(servers)).udp };
    await ev(pageB, (n) => window.t.close(n), name + '-nolock');
    R.steps.reverse[csp] = out;
  }

  // ---------- 3b. 導航外洩（iframe 把自己導到外部網址） ----------
  R.steps.navigation = {};
  for (const [csp, pframe] of [['spec', false], ['hardened', false], ['spec', true]]) {
    const p = await newPage('nonce', true, pframe);
    await openHost(p, 'nav', { ...O, csp });
    s0 = snap(servers);
    await ev(p, (u) => window.t.navigateSelf('nav', u), `${servers.decoyOrigin}/hit?k=nav`);
    await sleep(500);
    const d = delta(s0, await settled(servers));
    R.steps.navigation[csp + (pframe ? '+parentFrameSrcOpen' : '')] = { decoyHits: hitsFor(d, 'nav'), frameUrls: p.frames().map((f) => f.url().slice(0, 60)), violations: p.violations.slice(0, 3) };
    await p.context().close();
  }

  // ---------- 4. 時間與亂數覆寫 ----------
  R.steps.clock = {};
  await openHost(page, 'c1', O); await ev(page, () => window.t.plugin('c1', 'gl'));
  await openHost(page, 'c2', O); await ev(page, () => window.t.plugin('c2', 'gl'));
  const w1 = await ev(page, () => window.t.clock('c1', 2.5));
  const w2 = await ev(page, () => window.t.clock('c2', 2.5));
  const w1b = await ev(page, () => window.t.clock('c1', 2.5));
  await openHost(pageB, 'c3', O);
  const m1 = await ev(pageB, () => window.t.clockMain('c3', 2.5));
  const BASE = Date.UTC(2026, 0, 1);
  R.steps.clock = {
    worker: w1, iframeMain: m1, realNow: Date.now(),
    workerDateNowIsSegmentTime: w1.dateNow === BASE + 2500,
    workerNewDateIsSegmentTime: w1.newDate === BASE + 2500,
    workerPerfNowIsSegmentTime: w1.perfNow === 2500,
    workerCtorLeakClosed: w1.ctorLeak === BASE + 2500,
    workerIntlFormatNoArg: w1.intl,
    sameSeedSameSequence_acrossRepeatAndWorkers: JSON.stringify(w1.rand) === JSON.stringify(w2.rand) && JSON.stringify(w1.rand) === JSON.stringify(w1b.rand),
    iframeMainDateNowIsSegmentTime: m1.dateNow === BASE + 2500, iframeMainPerfNow: m1.perfNow,
    iframeMainSameSeedAsWorker: JSON.stringify(m1.rand) === JSON.stringify(w1.rand),
  };
  await ev(page, () => window.t.close('c1')); await ev(page, () => window.t.close('c2'));

  // ---------- 5. 逾時終止 Worker ----------
  R.steps.timeout = { cycles: [] };
  await openHost(page, 'to', O);
  await ev(page, () => window.t.startHeartbeat());
  for (const budget of [100, 100, 100, 30, 30]) {
    await ev(page, () => window.t.plugin('to', 'hang'));
    const before = await workerTargets();
    await ev(page, () => window.t.hangWorker('to'));
    await sleep(150); // 讓 Worker 真的進入無窮迴圈
    const duringHang = await workerTargets();
    const rec = await ev(page, (b) => window.t.timeoutRecover('to', b), budget, 20000);
    // timeoutRecover 重建了新 worker；舊的（卡死的）target 是否已消失
    let after = [];
    for (let i = 0; i < 20; i++) { after = await workerTargets(); if (!duringHang.some((x) => after.some((y) => y.id === x.id))) break; await sleep(100); }
    const hungIds = duringHang.filter((x) => !before.some((y) => y.id === x.id)).map((x) => x.id);
    const hungStillAlive = duringHang.some((x) => after.some((y) => y.id === x.id));
    rec.budgetMs = budget; rec.workerTargets = { before: before.length, duringHang: duringHang.length, afterRecover: after.length }; rec.hungWorkerGone = !hungStillAlive;
    R.steps.timeout.cycles.push(rec);
    await ev(page, () => window.t.kill('to')); // 清掉重建出來的 gl worker，下一輪才不會累積
  }
  R.steps.timeout.mainHeartbeat = await ev(page, () => window.t.heartbeat());
  await ev(page, () => window.t.close('to'));
  await openHost(page, 'churn', O);
  R.steps.churn = await ev(page, () => window.t.churn('churn', 40), null, 120000);
  await ev(page, () => window.t.close('churn'));
  await page.context().close();

  }
  // ---------- 6. 退路：iframe 主執行緒無窮迴圈 ----------
  R.steps.fallbackMainLoop = {};
  const fp = await newPage('nonce', true);
  await openHost(fp, 'fb', O);
  await ev(fp, () => window.t.plugin('fb', 'gl'));
  R.steps.fallbackMainLoop.targetTypesBefore = (await allTargets()).filter((t) => t !== 'browser').join(',');
  await ev(fp, () => window.t.startHeartbeat());
  await ev(fp, () => window.t.hangMain('fb'));
  await sleep(1500);
  try {
    const hb = await ev(fp, () => window.t.heartbeat(), null, 4000);
    R.steps.fallbackMainLoop.heartbeatDuringHang = hb;
    R.steps.fallbackMainLoop.mainBlocked = hb.maxGapMs > 500;
    R.steps.fallbackMainLoop.targetTypesDuringHang = (await allTargets()).filter((t) => t !== 'browser').join(',');
    const rb = await ev(fp, (o) => window.t.removeAndRebuild('fb', o), O, 15000);
    R.steps.fallbackMainLoop.removeAndRebuild = rb;
    R.steps.fallbackMainLoop.recovered = rb.rebuildOk;
  } catch (e) {
    R.steps.fallbackMainLoop.mainBlocked = true;
    R.steps.fallbackMainLoop.error = String(e.message);
    R.steps.fallbackMainLoop.recovered = false;
  }
  await fp.context().close();

  await browser.close();
  return R;
}

// ---------- 主程式 ----------
const arg = process.argv.find((a) => a.startsWith('--env='));
const ids = arg ? arg.slice(6).split(',') : Object.keys(ENVS).filter((k) => !ENVS[k].onlyFallback);
const servers = await startServers();
console.log(`主頁 ${servers.mainOrigin}　誘餌 ${servers.decoyOrigin}　STUN ${servers.udpPort}`);
fs.mkdirSync(path.join(ROOT, 'results'), { recursive: true });
for (const id of ids) {
  console.log(`\n===== ${id} =====`);
  try {
    const r = await runEnv(id, servers);
    fs.writeFileSync(path.join(ROOT, 'results', `${id}.json`), JSON.stringify(r, null, 2));
    console.log(JSON.stringify(r, null, 2).slice(0, 200000));
  } catch (e) {
    console.error(`${id} 失敗：`, e);
    fs.writeFileSync(path.join(ROOT, 'results', `${id}.json`), JSON.stringify({ env: id, crash: String(e.stack || e) }, null, 2));
  }
}
await servers.close();
process.exit(0);
