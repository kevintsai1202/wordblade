# Tauri（WebView2）環境實測（10/27 ⑤⑥）

- 日期：2026-10-27；WebView2：Edg/155.0.0.0；Tauri 2 除錯版，頁面網址 `http://tauri.localhost/`（和正式版相同）
- 怎麼重跑：見 `run-check.ps1` 開頭的說明；原始紀錄在 `RESULT.json`

| 項目 | 結果 | 對 spec 的影響 |
| --- | --- | --- |
| ⑤ `fetch` 送出的 Origin | GET、POST 都是 `http://tauri.localhost`；帶 `Authorization` 的 POST 先發 OPTIONS 預檢 | §6：閘道 CORS 放行 `http://tauri.localhost`（不必改走 `tauri-plugin-http`） |
| WebCodecs H.264（1080p、`prefer-hardware`） | `isConfigSupported` → supported | D24 在 Windows 版可行；速度另見 `spikes/export-bench` |
| `crossOriginIsolated` | false | 要用 WASM 多執行緒（JASSUB）時，Tauri 要另外設 COOP／COEP 標頭 |
| ⑥ 麥克風 `getUserMedia` | 20 秒內沒有回應：卡在 WebView2 的權限詢問（無人按允許） | §5.18：Rust 端處理 WebView2 的 `PermissionRequested`，只對 `http://tauri.localhost` 自動允許麥克風；或保留詢問讓使用者按允許。待人工按一次允許確認錄得到 |
