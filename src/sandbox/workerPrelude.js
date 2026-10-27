// 沿用 spikes/sandbox/public/worker-prelude.js（10/27 實測）。
// 在「插件程式之前」先執行的前置腳本（Worker 與 iframe 主執行緒共用）：
// 固定亂數種子、把時間函式換成「區段時間」，讓畫面只由 t 與 env 決定（spec §5.7 可重現規則）。
// 區段時間由 globalThis.__clock.ms 提供，harness 每格依 t 更新。
(function (g) {
  'use strict';
  /** 目前的區段時間（毫秒），harness 每格依 t 設定；預設 0。 */
  const clock = (g.__clock = { ms: 0, base: Date.UTC(2026, 0, 1) });

  /** mulberry32：固定種子的亂數產生器。 */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  let rng = mulberry32(12345);
  /** 重設亂數種子（每次從區段開頭重跑時呼叫）。 */
  g.__reseed = (s) => { rng = mulberry32(s); };
  Math.random = function random() { return rng(); };

  // performance.now：改在 prototype 與實例上都覆寫，避免用 Performance.prototype.now.call 取回真實時間
  const fakeNow = function now() { return clock.ms; };
  try { Object.defineProperty(Performance.prototype, 'now', { value: fakeNow, configurable: true, writable: true }); } catch (e) { /* 忽略 */ }
  try { Object.defineProperty(g.performance, 'now', { value: fakeNow, configurable: true, writable: true }); } catch (e) { /* 忽略 */ }
  try { Object.defineProperty(Performance.prototype, 'timeOrigin', { get() { return clock.base; }, configurable: true }); } catch (e) { /* 忽略 */ }

  // Date：Date.now 與「無參數 new Date()」都回傳區段時間；有參數時行為照舊
  const RealDate = g.Date;
  function FakeDate(...args) {
    if (!new.target) return new RealDate(clock.base + clock.ms).toString();
    return args.length === 0 ? new RealDate(clock.base + clock.ms) : new RealDate(...args);
  }
  FakeDate.prototype = RealDate.prototype;
  FakeDate.now = () => clock.base + clock.ms;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  // 堵住「用 new Date().constructor 取回真的 Date」的後門
  Object.defineProperty(RealDate.prototype, 'constructor', { value: FakeDate, configurable: true, writable: true });
  g.Date = FakeDate;

  // Intl.DateTimeFormat().format() 沒帶參數時會用真實時間：包起來改用區段時間
  try {
    const desc = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, 'format');
    if (desc && desc.get) {
      Object.defineProperty(Intl.DateTimeFormat.prototype, 'format', {
        configurable: true,
        get() {
          const bound = desc.get.call(this);
          return (d) => bound(d === undefined ? new FakeDate() : d);
        },
      });
    }
  } catch (e) { /* 忽略 */ }
})(globalThis);
