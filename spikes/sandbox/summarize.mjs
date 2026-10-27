// 把 results/*.json 彙整成對照表（stdout），寫 RESULT.md 時用。
import fs from 'node:fs';

const ids = ['chromium-headed', 'msedge-headed', 'chromium-headless'];
const R = Object.fromEntries(ids.map((i) => [i, JSON.parse(fs.readFileSync(`results/${i}.json`, 'utf8'))]));
const row = (label, f) => console.log(`| ${label} | ${ids.map((i) => { try { return f(R[i]); } catch (e) { return 'n/a'; } }).join(' | ')} |`);
console.log(`| 項目 | ${ids.join(' | ')} |\n|---|---|---|---|`);
row('瀏覽器版本', (r) => r.browserVersion);
row('主頁 WebGL renderer', (r) => r.env_info.mainRenderer);
row('Worker WebGL renderer', (r) => r.steps.bench.workerGl.renderer);
row('fatal/crash', (r) => r.fatal || r.crash || '無');
for (const v of ['nonce/spec', 'nonce/hardened', 'hash/spec', 'blob/spec']) row('啟動 ' + v, (r) => { const x = r.steps.variants[v]; return x.open.ok ? (x.plugin.ok ? `通過 boot ${x.open.bootMs}ms，像素錯 ${x.pixelMismatches}` : 'worker 失敗 ' + x.plugin.error) : '失敗：' + x.open.error; });
row('inline nonce script 內嵌', (r) => String(r.steps.inlineMainScript.inlineRan));
for (const k of ['directSmallReadback', 'directFullReadback', 'relayFullReadback']) {
  for (const m of ['sendToWorkerAndBack', 'readback', 'roundTripTotalExclCreate', 'perFrameTotal', 'createImageBitmap', 'mainUploadDraw']) row(`${k}.${m} mean/p95/max ms`, (r) => { const x = r.steps.bench[k][m]; return `${x.mean} / ${x.p95} / ${x.max}`; });
  row(`${k}.像素不符格數`, (r) => String(r.steps.bench[k].mismatches));
}
row('決定性（同格兩次雜湊相等）', (r) => String(r.steps.bench.determinism.equal));
row('gl worker setup / scriptLoad / init ms', (r) => `${r.steps.bench.setupMs} / ${r.steps.bench.scriptLoadMs} / ${r.steps.bench.initMs}`);
row('three 啟動 setup ms（三次）', (r) => r.steps.three.startups.map((s) => `${s.setupMs}(load ${s.scriptLoadMs}+init ${s.initMs})`).join(', '));
row('three 版本／webgl2', (r) => `${r.steps.three.info.three}/${r.steps.three.info.webgl2}`);
row('three 60 格 mean/p95 ms、像素不符', (r) => `${r.steps.three.frames.roundTripWithReadback.mean}/${r.steps.three.frames.roundTripWithReadback.p95}、${r.steps.three.frames.mismatches}`);
for (const csp of ['spec', 'hardened']) {
  for (const part of ['worker', 'iframeMain']) {
    row(`反向 ${csp}/${part} 失敗項`, (r) => { const x = r.steps.reverse[csp][part]; const bad = Object.entries(x).filter(([, v]) => !v.pass).map(([k]) => k); return `${Object.keys(x).length} 項，失敗：${bad.join(',') || '無'}`; });
  }
  row(`RTC ${csp} lockdown 後 udp 封包`, (r) => String(r.steps.reverse[csp].rtcAfterLockdown.udpPackets));
  row(`RTC ${csp} 未 lockdown udp 封包`, (r) => String(r.steps.reverse[csp].rtcWithoutLockdown.udpPackets));
  row(`parent 存取 ${csp}`, (r) => Object.entries(r.steps.reverse[csp].parentAccess).map(([k, v]) => `${k}:${v.blocked ? '擋' : '漏'}`).join(' '));
}
row('對照組 udp 封包', (r) => String(r.steps.reverse.control.rtc.udpPackets));
row('對照組(主頁) 到達誘餌', (r) => JSON.stringify(r.steps.reverse.control.reached));
row('對照組(Worker) 到達誘餌', (r) => JSON.stringify(r.steps.reverse.control.worker.reached));
row('Worker 內 blob importScripts（父頁放行 blob 時）', (r) => String(!r.steps.reverse.spec.workerWhenParentAllowsBlobScript.importScriptsBlobControl.blocked));
for (const k of ['spec', 'hardened', 'spec+parentFrameSrcOpen']) row(`導航外洩 ${k}：誘餌收到`, (r) => String(r.steps.navigation[k].decoyHits));
row('時間 Date.now／new Date／perf.now／ctor', (r) => [r.steps.clock.workerDateNowIsSegmentTime, r.steps.clock.workerNewDateIsSegmentTime, r.steps.clock.workerPerfNowIsSegmentTime, r.steps.clock.workerCtorLeakClosed].join('/'));
row('亂數同種子序列相同', (r) => String(r.steps.clock.sameSeedSameSequence_acrossRepeatAndWorkers && r.steps.clock.iframeMainSameSeedAsWorker));
row('Intl 無參數 format', (r) => r.steps.clock.workerIntlFormatNoArg);
row('未覆蓋：perf.mark／event.timeStamp', (r) => `${Math.round(r.steps.clock.worker.perfMarkStart)}/${Math.round(r.steps.clock.worker.evtTimeStamp)}`);
R['chromium-headed'].steps.timeout.cycles.forEach((_, i) => row(`逾時第${i + 1}輪 預算/偵測/kill/重建/首格 ms、舊 worker 已消失`, (r) => { const c = r.steps.timeout.cycles[i]; return `${c.budgetMs}/${c.detectMs}/${c.killMs}/${c.rebuildMs}/${c.firstFrameAfterMs}、${c.hungWorkerGone}、像素${c.pixelsOk}`; }));
row('逾時期間主頁心跳最大間隔 ms', (r) => String(r.steps.timeout.mainHeartbeat.maxGapMs));
row('退路：iframe 主執行緒無窮迴圈 主頁被卡？', (r) => String(r.steps.fallbackMainLoop.mainBlocked));
row('退路：心跳最大間隔 ms', (r) => String(r.steps.fallbackMainLoop.heartbeatDuringHang && r.steps.fallbackMainLoop.heartbeatDuringHang.maxGapMs));
row('退路：移除並重建成功', (r) => JSON.stringify(r.steps.fallbackMainLoop.removeAndRebuild || r.steps.fallbackMainLoop.error));
row('退路：CDP target 類型', (r) => r.steps.fallbackMainLoop.targetTypesDuringHang);
row('建/殺 Worker×40：每次啟動 mean/p95/max ms、最後像素不符、錯誤數', (r) => `${r.steps.churn.startMs.mean}/${r.steps.churn.startMs.p95}/${r.steps.churn.startMs.max}、${r.steps.churn.finalMismatches}、${r.steps.churn.hostErrors}`);
