// 沙盒 iframe 內的執行環境（以 inline script 放進 srcdoc，受 nonce／hash 保護）。
// 這支程式本身是「我們寫的、可信的」，負責：
//   - 啟動後通知父頁（boot），接收父頁轉移過來的控制用 MessagePort
//   - lockdown：刪掉能連網的建構子（WebRTC）
//   - start-worker：把父頁送來的原始碼包成 blob URL 建 Worker，並把資料通道交給父頁（direct）或自己轉送（relay）
//   - kill-worker：worker.terminate()
//   - run-main：把原始碼以 blob: script 載入主執行緒（「退路」：不走 Worker 的路線）
// 不能出現結束 script 標籤的字樣，否則 srcdoc 會被截斷。
(function () {
  'use strict';
  /** 與父頁的控制通道（父頁用 MessageChannel 轉移進來）。 */
  let ctrl = null;
  /** 目前的 Worker。 */
  let worker = null;

  /** 找出訊息裡的 ImageBitmap，當成 transfer list。 */
  function transfersOf(data) {
    return data && typeof data === 'object'
      ? Object.values(data).filter((v) => typeof ImageBitmap !== 'undefined' && v instanceof ImageBitmap)
      : [];
  }

  /** 刪掉主執行緒上能連網的 WebRTC 建構子（CSP 擋不住 WebRTC，spec §5.7）。 */
  function lockdown() {
    for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
      try { delete window[k]; } catch (e) { /* 忽略 */ }
    }
  }

  /**
   * 以 blob URL 建立 Worker。
   * @param {string} source 完整的 worker 原始碼（prelude＋harness＋plugin）
   * @param {'direct'|'relay'} mode direct：把 MessagePort 直接交給 Worker，畫格不經過 iframe 主執行緒；relay：由 iframe 轉送
   */
  function startWorker(source, mode) {
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const w = new Worker(url);
    worker = w;
    w.onerror = (e) => ctrl.postMessage({ type: 'worker-error', message: String(e.message || e) });
    const mc = new MessageChannel();
    if (mode === 'direct') {
      w.postMessage({ type: 'port', port: mc.port1 }, [mc.port1]);
    } else {
      w.postMessage({ type: 'relay' });
      w.onmessage = (e) => mc.port1.postMessage(e.data, transfersOf(e.data));
      mc.port1.onmessage = (e) => w.postMessage(e.data, transfersOf(e.data));
    }
    ctrl.postMessage({ type: 'worker-port', port: mc.port2 }, [mc.port2]);
  }

  /** 把原始碼以 blob: script 載入主執行緒（script-src blob: 放行），結果用 window.__report 回報。 */
  function runMain(id, source) {
    window.__report = (result) => ctrl.postMessage({ type: 'main-result', id, result });
    window.onerror = (m) => ctrl.postMessage({ type: 'main-error', id, message: String(m) });
    const s = document.createElement('script');
    s.src = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    s.onerror = () => ctrl.postMessage({ type: 'main-error', id, message: 'script load error' });
    document.head.appendChild(s);
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'init' && e.data.port && !ctrl) {
      ctrl = e.data.port;
      ctrl.onmessage = (m) => {
        const d = m.data;
        if (d.cmd === 'lockdown') { lockdown(); ctrl.postMessage({ type: 'locked', id: d.id }); }
        else if (d.cmd === 'start-worker') startWorker(d.source, d.mode);
        else if (d.cmd === 'kill-worker') { if (worker) worker.terminate(); worker = null; ctrl.postMessage({ type: 'killed', id: d.id }); }
        else if (d.cmd === 'run-main') runMain(d.id, d.source);
        else if (d.cmd === 'ping') ctrl.postMessage({ type: 'pong', id: d.id });
      };
      ctrl.postMessage({ type: 'ready' });
    }
  });
  parent.postMessage({ type: 'boot' }, '*');
})();
