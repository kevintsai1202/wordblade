# 來源

`plane3d_math.js` 原樣複製自作者先前的專案 transcript-review（Apache-2.0）`frontend/plane3d_math.js`，commit `7d4badc`（2026-10-27 複製；原專案 2026-10-25 寫成，在黑客松前）：
平面轉 3D 的純函式數學（緩動、頭尾回平面、關鍵幀時間、姿勢內插、四角投影、有效性）。開發者 2026-10-27 決定「漂浮的板子」沿用原專案的板子姿勢關鍵幀（`docs/plan-10-30.md`）。
它是經典腳本（全域 `PLANE3D`，有 `module.exports` 守衛）：3D 插件把它串在程式前面一起送進沙盒 Worker，Vitest 用 `require` 載入，主程式用 `../plane3d.ts` 載入。沒有改動。
