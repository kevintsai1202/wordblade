// 沙盒 iframe 內的啟動腳本（spec §5.7；沿用 spikes/sandbox 實測過的版本，拿掉不採用的主執行緒路線）。
// 以 inline script 放進 srcdoc，iframe 的 CSP 用這段原文的 sha256 放行（換行一律 LF，雜湊才對得上）。
// 這支程式本身是「我們寫的、可信的」，負責：
//   - 啟動後通知父頁（boot），接收父頁轉移過來的控制用 MessagePort
//   - lockdown：刪掉能連網的建構子（WebRTC）
//   - start-worker：把父頁送來的原始碼包成 blob URL 建 Worker（可以有多個，以 id 區分），資料通道直接交給父頁
//   - kill-worker：終止指定 id 的 Worker
// 不能出現結束 script 標籤的字樣，否則 srcdoc 會被截斷。
(function () {
  'use strict';
  /** 與父頁的控制通道（父頁用 MessageChannel 轉移進來）。 */
  let ctrl = null;
  /** 目前的 Worker：id → Worker（2D 沙盒只有一個；3D 沙盒每個特效一個） */
  const workers = new Map();

  /** 刪掉主執行緒上能連網的 WebRTC 建構子（CSP 擋不住 WebRTC，spec §5.7）。 */
  function lockdown() {
    for (const k of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel']) {
      try { delete window[k]; } catch (e) { /* 忽略 */ }
    }
  }

  /**
   * 以 blob URL 建立 Worker（同一個 id 已經有就先終止）。資料通道的 MessagePort 直接交給 Worker，畫格不經過 iframe 主執行緒。
   * @param {string} id Worker 的 id
   * @param {string} source 完整的 worker 原始碼（prelude＋執行環境＋插件＋harness）
   */
  function startWorker(id, source) {
    killWorker(id);
    const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
    const w = new Worker(url);
    workers.set(id, w);
    w.onerror = (e) => ctrl.postMessage({ type: 'worker-error', id, message: String(e.message || e) });
    const mc = new MessageChannel();
    w.postMessage({ type: 'port', port: mc.port1 }, [mc.port1]);
    ctrl.postMessage({ type: 'worker-port', id, port: mc.port2 }, [mc.port2]);
  }

  /** 終止某個 Worker */
  function killWorker(id) {
    const w = workers.get(id);
    if (w) { w.terminate(); workers.delete(id); }
  }

  window.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'init' && e.data.port && !ctrl) {
      ctrl = e.data.port;
      ctrl.onmessage = (m) => {
        const d = m.data;
        if (d.cmd === 'lockdown') { lockdown(); ctrl.postMessage({ type: 'locked', id: d.id }); }
        else if (d.cmd === 'start-worker') startWorker(d.id, d.source);
        else if (d.cmd === 'kill-worker') { killWorker(d.id); ctrl.postMessage({ type: 'killed', id: d.id }); }
        else if (d.cmd === 'ping') ctrl.postMessage({ type: 'pong', id: d.id });
      };
      ctrl.postMessage({ type: 'ready' });
    }
  });
  parent.postMessage({ type: 'boot' }, '*');
})();
