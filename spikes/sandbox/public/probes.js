// 反向檢查探針（Worker 與 iframe 主執行緒共用）：模擬「壞插件」想做的事，看是不是被擋。
// 每個探針回傳 { blocked: boolean, detail: string }；blocked=true 代表「想做的事沒成功」。
// 另外由伺服器端的誘餌記錄交叉驗證：被擋的連線不該在誘餌留下任何請求。
(function (g) {
  'use strict';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const isWorker = typeof WorkerGlobalScope !== 'undefined' && g instanceof WorkerGlobalScope;

  /** 執行 fn；丟例外或 reject 算「被擋」，正常完成算「通過（沒擋住）」。 */
  async function attempt(fn) {
    try { const r = await fn(); return { blocked: false, detail: 'went through: ' + String(r).slice(0, 80) }; }
    catch (e) { return { blocked: true, detail: String(e && e.name || e) + ': ' + String(e && e.message || '').slice(0, 100) }; }
  }
  /** 等一個「有 open／load 事件算通過、有 error 事件算被擋」的物件，逾時算被擋（沒有連上）。 */
  function evented(make, okEvent, errEvent, ms = 1500) {
    return new Promise((resolve) => {
      let o;
      const done = (blocked, detail) => { try { o && o.close && o.close(); } catch (e) { /* 忽略 */ } resolve({ blocked, detail }); };
      try { o = make(); } catch (e) { return done(true, 'ctor threw ' + (e && e.name) + ': ' + String(e.message).slice(0, 100)); }
      o.addEventListener(okEvent, () => done(false, okEvent + ' fired'));
      o.addEventListener(errEvent, () => done(true, errEvent + ' fired'));
      setTimeout(() => done(true, 'no ' + okEvent + ' within ' + ms + 'ms'), ms);
    });
  }

  /** 所有探針。vars：{ http, ws, stunPort }。 */
  g.__probes = async function (vars) {
    const out = {};
    out.fetch = await attempt(() => fetch(vars.http + '/hit?k=fetch'));
    out.fetchData = await attempt(() => fetch('data:text/plain,hi'));
    out.fetchBlob = await attempt(() => fetch(URL.createObjectURL(new Blob(['x']))));
    out.xhr = await new Promise((resolve) => {
      try {
        const x = new XMLHttpRequest();
        x.open('GET', vars.http + '/hit?k=xhr');
        x.onload = () => resolve({ blocked: false, detail: 'status ' + x.status });
        x.onerror = () => resolve({ blocked: true, detail: 'xhr error event' });
        x.send();
      } catch (e) { resolve({ blocked: true, detail: String(e.name) + ': ' + String(e.message).slice(0, 80) }); }
    });
    out.websocket = await evented(() => new WebSocket(vars.ws + '/hit?k=ws'), 'open', 'error');
    out.eventsource = await evented(() => new EventSource(vars.http + '/hit?k=sse'), 'open', 'error');
    out.eval = await attempt(() => eval('1+1'));
    out.newFunction = await attempt(() => new Function('return 1')());
    out.dynamicImport = await attempt(() => import(vars.http + '/hit-k-import.js'));
    if (isWorker) {
      out.importScriptsExternal = await attempt(() => importScripts(vars.http + '/hit?k=importScripts'));
      // 正面對照：blob: 的 importScripts 應該可以（script-src blob: 放行），證明不是「全部都壞掉」
      out.importScriptsBlobControl = await attempt(() => importScripts(URL.createObjectURL(new Blob(['void 0'], { type: 'text/javascript' }))));
      out.importScriptsBlobControl.expectBlocked = false;
      out.sendBeacon = { blocked: typeof navigator.sendBeacon !== 'function', detail: 'typeof navigator.sendBeacon = ' + typeof navigator.sendBeacon };
      // Worker 裡有沒有 RTCPeerConnection（有的話就是漏洞：Worker 沒辦法靠「刪建構子」處理）
      out.rtcInWorker = { blocked: typeof g.RTCPeerConnection !== 'function' && typeof g.webkitRTCPeerConnection !== 'function', detail: 'typeof RTCPeerConnection = ' + typeof g.RTCPeerConnection };
    } else {
      out.sendBeacon = await attempt(async () => { if (!navigator.sendBeacon(vars.http + '/hit?k=beacon', 'x')) throw new Error('sendBeacon returned false'); return true; });
      out.imgBeacon = await evented(() => { const i = new Image(); i.src = vars.http + '/hit?k=img'; return i; }, 'load', 'error');
      out.windowOpen = await attempt(() => { const w = window.open(vars.http + '/hit?k=open'); if (!w) throw new Error('window.open returned null'); return 'opened'; });
    }
    return out;
  };

  /** 只在 iframe 主執行緒跑：RTCPeerConnection（含「開一個內層 iframe 取回全新 window」的繞法）。 */
  g.__probeRtc = async function (vars) {
    const out = { typeofCtor: typeof g.RTCPeerConnection, webkitTypeof: typeof g.webkitRTCPeerConnection };
    out.directBlocked = (await attempt(() => new g.RTCPeerConnection())).blocked;
    // 繞法：內層 iframe 是全新的 window，會有未被刪掉的建構子；同源（都是 opaque 且 srcdoc 繼承）所以拿得到
    let R = null;
    try {
      const f = document.createElement('iframe');
      document.documentElement.appendChild(f);
      out.nestedIframeAttached = !!f.contentWindow;
      R = f.contentWindow && f.contentWindow.RTCPeerConnection;
      out.nestedCtorAvailable = typeof R === 'function';
    } catch (e) { out.nestedError = String(e.name) + ': ' + String(e.message).slice(0, 100); }
    // 沒有被刪掉的話，直接用主視窗的建構子打 STUN（證明 CSP 擋不住 WebRTC）
    if (!R && typeof g.RTCPeerConnection === 'function') R = g.RTCPeerConnection;
    if (R) {
      try {
        const pc = new R({ iceServers: [{ urls: 'stun:127.0.0.1:' + vars.stunPort }] });
        pc.createDataChannel('x');
        await pc.setLocalDescription(await pc.createOffer());
        await wait(1500);
        pc.close();
      } catch (e) { out.nestedUseError = String(e.name) + ': ' + String(e.message).slice(0, 100); }
    }
    return out;
  };

  /** 只在 iframe 主執行緒跑：拿不拿得到 parent 的東西。每項 blocked=true 代表「拿不到」（好）。 */
  g.__probeParent = async function () {
    const out = {};
    out.parentDocument = await attempt(() => parent.document.title);
    out.parentBody = await attempt(() => parent.document.body.innerHTML);
    out.parentSecretVar = await attempt(() => parent.__secret);
    out.parentLocalStorage = await attempt(() => parent.localStorage.getItem('secret'));
    out.topLocation = await attempt(() => top.location.href);
    out.ownCookie = await attempt(() => document.cookie);
    out.ownLocalStorage = await attempt(() => localStorage.getItem('secret'));
    out.ownSessionStorage = await attempt(() => sessionStorage.getItem('secret'));
    out.indexedDB = await attempt(() => { const r = indexedDB.open('x'); return r; });
    out.origin = { blocked: true, detail: 'self.origin=' + g.origin };
    return out;
  };
})(globalThis);
