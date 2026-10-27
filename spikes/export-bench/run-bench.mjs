// 10/27 實測②的執行腳本：同一個合成分別用 ffmpeg 與 WebGL＋WebCodecs 匯出，量時間（D24 判準：WebCodecs ≤ ffmpeg × 1.5）。
// 用法（PowerShell，在 spikes/export-bench 下）：
//   node run-bench.mjs                      # 完整 11 分鐘：ffmpeg（qsv、mf）＋Chromium＋Edge
//   node run-bench.mjs --seconds 20         # 只跑前 20 秒，檢查流程用
//   node run-bench.mjs --only browser       # 只跑瀏覽器（ffmpeg 已量過時）
//   node run-bench.mjs --headed             # 開視窗跑（無頭模式拿不到硬體 GPU 時用）
//   node run-bench.mjs --scene3d            # 含 3D 區段（預設 60～120 秒；實測③）：只跑瀏覽器，不跑 ffmpeg
//   node run-bench.mjs --scene3d --s3d 5,15 --seconds 20 --snap   # 驗證流程：5～15 秒做 3D，存抽樣畫格 PNG 到 output/
//   node run-bench.mjs --seg                # 對照組：不開 3D，但量 60～120 秒區段的耗時（可配 --s3d、--browsers）
//   node run-bench.mjs --scene3d --browsers msedge                  # 只跑指定瀏覽器（chromium、msedge，逗號分隔）
// 結果寫到 output/results-<時間>.json；跑之前要讓機器閒置（不要同時編譯或跑其他重工作）。
import { spawn } from 'node:child_process';
import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';

/** 量測素材與輸出目錄 */
const SAMPLE = resolve('../../samples/bench-11min.mp4');
const OUT_DIR = resolve('output');

/** 解析命令列參數 */
function parseArgs(argv) {
  const args = { seconds: null, only: null, headed: false, dec: null, scene3d: false, s3d: null, snap: false, seg: false, probe: false, extra: null, browsers: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--seconds') args.seconds = Number(argv[++i]);
    else if (argv[i] === '--only') args.only = argv[++i];
    else if (argv[i] === '--headed') args.headed = true;
    else if (argv[i] === '--dec') args.dec = argv[++i];
    else if (argv[i] === '--scene3d') args.scene3d = true;
    else if (argv[i] === '--s3d') args.s3d = argv[++i];
    else if (argv[i] === '--snap') args.snap = true;
    else if (argv[i] === '--seg') args.seg = true;
    else if (argv[i] === '--probe') args.probe = true;
    else if (argv[i] === '--q') (args.extra ??= []).push(argv[++i]); // 額外的網址參數，例如 --q s3dAa=0
    else if (argv[i] === '--browsers') args.browsers = argv[++i].split(',');
    else throw new Error(`不認得的參數：${argv[i]}`);
  }
  return args;
}

/** 印出帶時間的訊息 */
function log(...parts) {
  console.log(new Date().toLocaleTimeString(), ...parts);
}

/** 用 ffmpeg 跑同一個合成：主畫面＋子母畫面（同片＋30 秒）＋混音，回傳耗時與輸出大小 */
function runFfmpeg(encoder, seconds) {
  const out = join(OUT_DIR, `ffmpeg-${encoder}.mp4`);
  const limit = seconds ? ['-t', String(seconds)] : [];
  const args = [
    '-v', 'error', '-y',
    '-i', SAMPLE,
    '-ss', '30', '-i', SAMPLE,
    '-filter_complex',
    '[1:v]scale=480:270[p];[0:v][p]overlay=1400:40:eof_action=pass[v];[1:a]volume=0.25[pa];[0:a][pa]amix=inputs=2:duration=first:normalize=0[a]',
    '-map', '[v]', '-map', '[a]',
    '-c:v', encoder, '-b:v', '8M', '-g', '60',
    '-c:a', 'aac', '-b:a', '160k',
    ...limit, out,
  ];
  return new Promise((resolveRun, reject) => {
    const started = performance.now();
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d; });
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`ffmpeg ${encoder} 失敗：${stderr.slice(-1000)}`));
      resolveRun({ encoder, seconds: (performance.now() - started) / 1000, bytes: statSync(out).size });
    });
  });
}

/** 在指定瀏覽器開量測頁，等它跑完，回傳頁面上的量測狀態 */
async function runBrowser(name, launchOptions, baseUrl, args) {
  const browser = await chromium.launch({
    headless: !args.headed,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', '--enable-unsafe-webgpu'],
    ...launchOptions,
  });
  try {
    const page = await browser.newPage();
    const query = new URLSearchParams({ hw: 'prefer-hardware', ...(args.dec ? { dec: args.dec } : {}) });
    if (args.seconds) query.set('seconds', String(args.seconds));
    if (args.scene3d) query.set('scene3d', '1');
    if (args.s3d) { const [a, b] = args.s3d.split(','); query.set('s3dStart', a); query.set('s3dEnd', b); }
    if (args.snap) query.set('snap', '1');
    if (args.probe) query.set('probe', '1');
    for (const extra of args.extra ?? []) { const [k, v] = extra.split('='); query.set(k, v); }
    if (args.seg) query.set('seg', '1');
    await page.goto(`${baseUrl}/?${query}`);
    const deadline = Date.now() + 40 * 60 * 1000;
    let state;
    let lastLog = 0;
    while (Date.now() < deadline) {
      await page.waitForTimeout(2000);
      state = await page.evaluate(() => window.__bench);
      if (state.status !== 'running') break;
      if (Date.now() - lastLog > 30000) {
        log(`${name}：${state.frames}/${state.totalFrames} 格，${(state.elapsedMs / 1000).toFixed(0)} 秒`);
        lastLog = Date.now();
      }
    }
    // 抽樣畫格另存成 PNG（結果 JSON 裡不留 data URL）
    for (const snap of state.snapshots ?? []) {
      writeFileSync(join(OUT_DIR, `snap-${name}-${snap.name}.png`), Buffer.from(snap.dataUrl.split(',')[1], 'base64'));
    }
    if (state.snapshots) state.snapshots = state.snapshots.map(s => s.name);
    return { browser: name, version: browser.version(), ...state, seconds: state.elapsedMs / 1000 };
  } finally {
    await browser.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  mkdirSync(OUT_DIR, { recursive: true });
  const results = { sample: SAMPLE, limitSeconds: args.seconds, startedAt: new Date().toISOString(), ffmpeg: [], browsers: [] };

  if (args.scene3d || args.seg) args.only = 'browser'; // ffmpeg 基準不含 3D，含 3D 時只跑瀏覽器
  if (args.only !== 'browser') {
    for (const encoder of ['h264_qsv', 'h264_mf']) {
      log(`ffmpeg ${encoder} 開始`);
      const r = await runFfmpeg(encoder, args.seconds);
      log(`ffmpeg ${encoder}：${r.seconds.toFixed(1)} 秒`);
      results.ffmpeg.push(r);
    }
  }

  if (args.only !== 'ffmpeg') {
    const server = await createServer({ configFile: resolve('vite.config.ts'), logLevel: 'warn' });
    await server.listen();
    const baseUrl = server.resolvedUrls.local[0].replace(/\/$/, '');
    try {
      const targets = [['chromium', {}], ['msedge', { channel: 'msedge' }]].filter(([name]) => !args.browsers || args.browsers.includes(name));
      for (const [name, options] of targets) {
        log(`${name} 開始`);
        const r = await runBrowser(name, options, baseUrl, args);
        log(`${name}：${r.status}，${r.seconds?.toFixed(1)} 秒，renderer ${r.webglRenderer}`);
        if (r.error) log(r.error);
        results.browsers.push(r);
      }
    } finally {
      await server.close();
    }
  }

  // D24 判準：最快的瀏覽器結果 ÷ 最快的 ffmpeg 結果
  const best = list => list.filter(r => !r.status || r.status === 'done').map(r => r.seconds).sort((a, b) => a - b)[0];
  const ffmpegBest = best(results.ffmpeg);
  const browserBest = best(results.browsers);
  if (ffmpegBest && browserBest) {
    results.ratio = browserBest / ffmpegBest;
    results.passesD24 = results.ratio <= 1.5;
    log(`比例 ${results.ratio.toFixed(2)}（判準 ≤ 1.5）：${results.passesD24 ? '通過' : '不通過'}`);
  }
  results.scene3d = args.scene3d;
  const file = join(OUT_DIR, `results-${args.scene3d ? '3d-' : args.seg ? 'seg-' : ''}${Date.now()}.json`);
  writeFileSync(file, JSON.stringify(results, null, 2));
  log(`結果 ${file}`);
}

main().catch(e => { console.error(e); process.exit(1); });
