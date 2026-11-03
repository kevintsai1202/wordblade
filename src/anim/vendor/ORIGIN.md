# 來源

這個資料夾與上一層的 `anim-library*.json`、`anim_api_manifest.json`、`legacy/*.cjs` 沿用作者先前的專案 transcript-review（Apache-2.0），複製自 commit `7d4badc`（2026-10-27 複製；這些檔案在原專案 2026-10-06 建立、最後修改 10-21，都在黑客松前）。開發者 2026-10-27 決定 2D 插件沿用它的直譯器，放進沙盒 Worker 執行（spec §5.7）。

| 檔案 | 原位置 | 改動 |
| --- | --- | --- |
| `acorn.js`、`acorn.LICENSE` | `frontend/vendor/` | 無（acorn 8.19.0，MIT） |
| `anim_vm.js` | `frontend/anim_vm.js` | 無 |
| `anim_runtime.js` | `frontend/anim_runtime.js` | `compositeLayer` 在沒有 `document` 時（Worker）改用 `OffscreenCanvas`；字型指紋的量測字串拿掉原專案名稱 |
| `../anim-library.json`、`../anim-library.en.json` | `frontend/` | 無（英文翻譯在 `../library.ts` 載入時蓋上） |
| `../anim_api_manifest.json` | `frontend/` | 無（給 Vibe特效模型的 API 說明；`legacy` 測試確認和 `apiManifest()` 一致） |
| `../legacy/*.cjs` | `scripts/anim-*-unit.js` | 路徑；`test()` 在 Vitest 下改成登記；拿掉和原專案 Python 禁用字詞清單的比對 |

原專案名稱是商標，不在 WordBlade 的介面與發行檔裡使用。
