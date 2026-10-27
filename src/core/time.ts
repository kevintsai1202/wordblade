import type { Seconds } from "./model";

// 時間精度：模型裡的時間一律在每次編輯結束時量化到微秒（1e-6 秒）。
// 這樣測試可以用完全相等比較，V2 以上與音軌反覆位移也不會累積浮點誤差。

/** 量化到微秒 */
export function roundTime(t: Seconds): Seconds {
  const r = Math.round(t * 1e6) / 1e6;
  return Object.is(r, -0) ? 0 : r;
}
