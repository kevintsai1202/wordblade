// Worker 內的 harness（接在 prelude 與插件程式之後）：
// 接收資料通道（direct：父頁轉移進來的 MessagePort；relay：直接用 self），
// 依訊息呼叫插件的 init／render／probe，畫完以 transferToImageBitmap 回傳。
// 插件契約（此 spike 的最小版）：self.plugin = { init(canvas, msg), render(t, bitmap), probe(vars) }
(function (g) {
  'use strict';
  /** 資料通道：MessagePort（direct）或 self（relay）。 */
  let chan = null;
  /** 插件要畫的 OffscreenCanvas，init 時建立。 */
  let canvas = null;

  /** 處理來自父頁（或 iframe 轉送）的訊息。 */
  async function handle(e) {
    const d = e.data;
    try {
      if (d.type === 'init') {
        canvas = new OffscreenCanvas(d.width, d.height);
        const info = await g.plugin.init(canvas, d);
        chan.postMessage({ type: 'ready', info });
      } else if (d.type === 'render') {
        g.__clock.ms = d.t * 1000; // 區段時間
        g.__reseed(1000 + (d.seed || 0));
        g.plugin.render(d.t, d.bitmap);
        const out = canvas.transferToImageBitmap();
        if (d.bitmap) d.bitmap.close();
        chan.postMessage({ type: 'frame', id: d.id, bitmap: out }, [out]);
      } else if (d.type === 'probe') {
        const result = await g.plugin.probe(d.vars);
        chan.postMessage({ type: 'probe-result', id: d.id, result });
      } else if (d.type === 'ping') {
        chan.postMessage({ type: 'pong', id: d.id });
      } else if (d.type === 'clock') {
        g.__clock.ms = d.t * 1000;
        g.__reseed(7);
        chan.postMessage({
          type: 'clock-result', id: d.id,
          result: {
            dateNow: Date.now(), newDate: +new Date(), perfNow: performance.now(), timeOrigin: performance.timeOrigin,
            ctorLeak: +new (new Date().constructor)(),
            // 以下兩項是「沒被蓋掉的時間來源」：只記錄，不算通過／失敗
            perfMarkStart: performance.mark('m').startTime, evtTimeStamp: e.timeStamp, perfEntryCount: performance.getEntries().length, intl: new Intl.DateTimeFormat('en', { dateStyle: 'short', timeStyle: 'medium', timeZone: 'UTC' }).format(),
            rand: [Math.random(), Math.random(), Math.random()],
          },
        });
      } else if (d.type === 'hang') {
        for (;;) { /* 故意無窮迴圈：測逾時終止 */ }
      }
    } catch (err) {
      chan.postMessage({ type: 'error', id: d.id, message: String(err && err.stack || err) });
    }
  }

  g.onmessage = (e) => {
    if (e.data.type === 'port') { chan = e.data.port; chan.onmessage = handle; }
    else if (e.data.type === 'relay') { chan = g; g.onmessage = handle; }
  };
})(globalThis);
