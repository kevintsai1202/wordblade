# 沙盒實測結果（spec §5.7、D24）

日期：2026-10-27。實測機器：Windows 11、Intel Arc 內顯（無獨立顯卡）、Chromium 156.0.8078.4（Playwright 1.64.1 附的）、Edge 156.0.4314.42。
原始資料：`results/*.json`（每個環境一份）、`results/summary.md`（三環境對照表，由 `summarize.mjs` 產生）。

## 結論

**Worker 路線可行。** `sandbox="allow-scripts"`（沒有 same-origin）的 srcdoc iframe 裡，可以用 blob URL 建 Worker，Worker 裡的 `OffscreenCanvas` 拿得到 WebGL2（含本機打包的 three.js r186），`ImageBitmap` 雙向轉移的畫素逐格驗證全部正確，同一格重算兩次的整張讀回取樣雜湊（每 7 個位元組取 1 個）相同。網路類反向檢查在 Worker 與 iframe 主執行緒共 25 項全部擋下，而且誘餌伺服器端確認「真的沒有請求送出去」（對照組同樣的程式在沒沙盒的頁面能打到誘餌）。Worker 無窮迴圈在 3D 100 ms 預算內可偵測、`terminate()` 實際生效並重建，主頁不受影響。

**退路（iframe 主執行緒）不能當可靠退路。** 它能不能救回，取決於瀏覽器有沒有把沙盒 iframe 放進獨立行程：Chromium／Edge 156 有（主頁完全不卡，移除 iframe 後 220～260 ms 重建完成）；headless shell 或加 `--disable-features=IsolateSandboxedIframes` 時沒有，主頁永久卡死、只能殺行程。WebView2 屬哪一種還沒測（等 Tauri 骨架）。所以 Worker 路線過關後，建議把退路降為「偵測到沒有行程隔離就改走別的方案」，不要依賴它。

spec 的 CSP 字串**照抄有一處行不通**：srcdoc 繼承父頁 CSP，所以 iframe 的 inline 啟動腳本必須同時通過**父頁**的 `script-src`。父頁若是靜態 CSP（Tauri），nonce 寫不出來，要改用啟動腳本的 sha256 雜湊（已實測可行）。細節見下方「CSP」與「建議改 spec 的地方」。

## 結果表

### 1. 沙盒能不能跑 Worker＋WebGL2（三種啟動腳本寫法 × 兩種 iframe CSP）

| 項目 | chromium（有視窗） | msedge（有視窗） | chromium headless（對照） |
|---|---|---|---|
| nonce／iframe CSP=spec §5.7 原文 | 通過 | 通過 | 通過 |
| nonce／iframe CSP=spec＋`frame-src 'none'; base-uri 'none'; form-action 'none'` | 通過 | 通過 | 通過 |
| hash（sha256，父頁與 iframe 同一個雜湊） | 通過 | 通過 | 通過 |
| blob（啟動腳本用父頁建的 blob: URL 載入） | **失敗**（iframe 3 秒沒 boot） | 失敗 | 失敗 |
| 啟動腳本以外，再內嵌一段帶 nonce 的 inline script（退路的另一種寫法） | 通過 | 通過 | 通過 |
| three.js（本機 esbuild 打包，530 KB）在 Worker 建 `WebGLRenderer`、畫疊加物件（透明背景＋貼當格畫面） | 通過 | 通過 | 通過 |

「通過」＝iframe 啟動、Worker 建成、WebGL2 畫出一格且畫素正確。blob 變體失敗是因為沒有 same-origin 的 iframe 載不到父頁建的 blob URL，不是 CSP 問題。

### 2. ImageBitmap 雙向轉移與耗時（1920×1080，各 300 格，先暖機 20 格；單位 ms，mean／p95）

流程：主頁 `createImageBitmap(OffscreenCanvas)` → transfer 進 Worker → Worker WebGL2 畫（輸入貼圖反相＋標記）→ `transferToImageBitmap()` 轉回 → 主頁 WebGL 上傳貼圖、畫 → `readPixels` 驗 6 個點（上下左右方向、alpha=0 透明帶、綠色標記）。

| 項目 | chromium | msedge | chromium headless（SwiftShader） |
|---|---|---|---|
| 畫素不符的格數（三種模式都是 300 格） | 0 | 0 | 0 |
| 同一格算兩次，整張讀回的取樣雜湊（每 7 個位元組取 1 個） | 相同 | 相同 | 相同 |
| 送進 Worker→畫→轉回（direct：MessagePort 直接交給 Worker） | 2.6／3.8 | 2.6／3.3 | 39.1／57.3 |
| 主頁上傳貼圖＋畫 | 0.1／0.2 | 0.1／0.2 | 1.6／2.2 |
| 讀回 1 點（同步點，等 GPU 做完） | 15.6／20.5 | 17.1／20.4 | 19.8／30.5 |
| **每格合計（direct，讀回 1 點）** | **18.4／24.1** | **20.0／23.6** | **62.2／96.9** |
| 讀回整張 1920×1080（`readPixels` 8 MB） | 21.7／29.6 | 30.6／38.5 | 24.1／30.2 |
| **每格合計（direct，讀回整張）** | **24.3／32.3** | **35.5／45.7** | **63.3／77.6** |
| 每格合計（relay：經 iframe 主執行緒轉送，讀回整張） | 31.6／39.1 | 36.0／46.5 | 70.9／89.6 |
| three.js 插件，每格來回＋讀回 2 點（60 格） | 16.4／18.1 | 17.0／19.5 | 71.8／78.5 |

- 三個環境的 WebGL renderer（主頁與 Worker 相同）：
  - chromium、msedge：`ANGLE (Intel, Intel(R) Arc(TM) Graphics (0x00007D55) Direct3D11 vs_5_0 ps_5_0, D3D11)`，是硬體（D3D11），不是 SwiftShader。
  - chromium headless：`ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`，是軟體算繪。
- 「讀回」是這個實測加的同步點，真正的合成器不需要每格 `readPixels`（`ImageBitmap` 直接當貼圖）。純轉移成本是「送進 Worker→畫→轉回」那一列：硬體 GPU 約 2.5～5 ms／格。
- 5 秒（150 格）3D 區段：硬體 GPU 讀回 1 點約 2.8～3.0 秒、讀回整張約 3.6～5.3 秒；軟體算繪 1080p 約 9.5～14 秒，three.js 在軟體算繪的單格 72 ms 離 100 ms 預算很近（印證 §5.21 的「軟體算繪用 720p」）。
- 數字每次跑會浮動（同一環境三次完整跑：direct 讀回整張的每格合計 mean 24～36 ms），偶有單格離群值（msedge 一次 649 ms、一次重建 839 ms）。請當量級看，不要當規格。
- relay 比 direct 每格多約 1～2 ms，兩者都可用；direct（把 MessagePort 交給 Worker）讓畫格不經過 iframe 主執行緒，iframe 主執行緒忙或卡住時不受影響，建議用 direct。
- Worker 啟動（腳本載入＋WebGL2 init）：簡單 shader 25～35 ms；three.js 約 65～390 ms（三次重建 mean 約 100～200 ms）。**首次完整跑 chromium 時 three.js 啟動量到 7438 ms，之後再跑都沒有重現**，原因未確認（猜是這台 GPU 驅動第一次編譯 three 的 shader、快取是冷的）；若用戶第一次開 3D 插件偶爾要等數秒，是這個。
- 反覆「建 Worker＋WebGL2→terminate」40 次：每次啟動 43～57 ms（mean），最後一次仍畫對，沒有 context 累積或錯誤。

### 3. 反向檢查（每項「通過」＝壞插件想做的事被擋，且誘餌伺服器沒收到請求）

Worker 與 iframe 主執行緒在三個環境、兩種 CSP 寫法（spec／hardened）結果完全相同。

| 檢查 | Worker 內 | iframe 主執行緒 |
|---|---|---|
| `fetch`（外部網址） | 通過（擋） | 通過（擋） |
| `fetch('data:…')`、`fetch(blob:)` | 通過（擋） | 通過（擋） |
| `XMLHttpRequest` | 通過（擋） | 通過（擋） |
| `new WebSocket` | 通過（擋） | 通過（擋） |
| `new EventSource` | 通過（擋） | 通過（擋） |
| `import('外部網址')` | 通過（擋） | 通過（擋） |
| `importScripts(外部網址)` | 通過（擋） | 不適用 |
| `eval`、`new Function` | 通過（擋，EvalError） | 通過（擋） |
| `navigator.sendBeacon` | 通過（Worker 沒有這個 API） | 通過（回傳 true，但誘餌沒收到請求） |
| `new Image().src=外部網址` | 不適用 | 通過（擋） |
| `window.open` | 不適用 | 通過（回傳 null） |
| Worker 裡有沒有 `RTCPeerConnection` | 通過（Chromium 156 的 Worker 沒有） | 不適用 |
| iframe 把自己導航到外部網址 | 見下 | 見下 |

對照組（沒沙盒、沒 CSP 的頁面與 Worker）：以上連線全部打得到誘餌（各 1 次），STUN 3 個 UDP 封包，證明「沒收到」有意義。

| 其他反向檢查 | 結果 |
|---|---|
| WebRTC：沒刪建構子時，CSP 擋得住嗎 | **擋不住**：iframe 內 `new RTCPeerConnection` 打 STUN，誘餌收到 3 個 UDP 封包（和對照組一樣） |
| WebRTC：iframe 主執行緒刪掉 `RTCPeerConnection`／`webkitRTCPeerConnection` 後 | 通過：`typeof` 為 undefined、無法建構、誘餌收到 0 個封包 |
| WebRTC：開內層 iframe 想取回全新 window 的建構子（繞法） | 通過（擋）：內層 about:blank 繼承 sandbox，是 cross-origin，讀 `contentWindow.RTCPeerConnection` 丟 SecurityError |
| iframe 讀 `parent.document`、`parent.__secret`、`parent.localStorage`、`top.location.href` | 通過（擋，SecurityError） |
| iframe 自己的 `document.cookie`、`localStorage`、`sessionStorage`、`indexedDB` | 通過（擋，SecurityError）；`self.origin` 為 `null` |
| iframe 主執行緒自我導航到外部網址：父頁 `frame-src 'none'` | 通過：被擋（誘餌 0 個請求），iframe 變 chrome-error 頁 |
| 同上，但父頁 `frame-src *`（對照） | **失敗：誘餌收到 1 個請求**（可外洩資料）。iframe 自己的 CSP 沒有 `navigate-to`，這條只能靠父頁擋 |
| 固定亂數種子：同種子序列在多次呼叫、兩個 Worker、iframe 主執行緒都相同 | 通過 |
| `Date.now`、無參數 `new Date()`、`performance.now`、`performance.timeOrigin` | 通過：回傳區段時間（t=2.5 s → +2500 ms） |
| `new Date().constructor` 取回真的 Date | 通過（已堵：改掉 `Date.prototype.constructor`） |
| `Intl.DateTimeFormat().format()` 無參數 | 通過（要額外包 `format`；只覆寫 `Date.now` 會漏，第一版就漏了） |
| `performance.mark().startTime`、`performance.getEntries()`、訊息事件的 `event.timeStamp` | **漏**：仍是真實的相對時間（量到 175～285 ms）。沒堵；此外用 `setTimeout`／忙迴圈自己當時鐘也堵不住 |

### 4. 逾時終止

| 項目 | chromium | msedge | chromium headless |
|---|---|---|---|
| Worker 無窮迴圈，預算 100 ms：偵測到逾時 | 111～117 ms | 101～111 ms | 106～115 ms |
| 預算 30 ms（2D）：偵測到逾時 | 31～32 ms | 31～32 ms | 32 ms |
| iframe 回覆 `terminate()` 完成 | 約 1 ms | 約 1 ms | 約 0.2 ms |
| 舊 Worker 真的消失（CDP `Target.getTargets` 的 worker 清單，id 不再存在；5 輪） | 5／5 | 5／5 | 5／5 |
| 重建 Worker＋WebGL2 | 67～239 ms（一次 839） | 36～50 ms | 16～27 ms |
| 重建後第一格 | 24～66 ms，畫素正確 | 25～39 ms，畫素正確 | 66～86 ms，畫素正確 |
| 逾時期間主頁心跳最大間隔（每 20 ms 一次） | 90 ms | 51 ms | 31 ms |

### 5. 退路：iframe 主執行緒無窮迴圈，主頁移除 iframe 能否恢復

| 環境 | 主頁被卡住？ | 移除 iframe 後 |
|---|---|---|
| chromium（有視窗） | 否（心跳最大間隔 21 ms；CDP 看得到獨立的 `iframe` target，即沙盒 iframe 在獨立行程） | 移除 0.3 ms，重建並畫出一格共 257 ms |
| msedge（有視窗） | 否（22 ms，同樣有獨立 `iframe` target） | 重建共 220 ms |
| chromium headless shell | **是**：4 秒內主頁連 `evaluate` 都回不來，沒有獨立 iframe target | 無法恢復（無法執行移除） |
| chromium 加 `--disable-features=IsolateSandboxedIframes`（有視窗） | **是**：同上，永久卡死 | 無法恢復 |

另外要注意：iframe 主執行緒要載入 blob: script，**父頁 CSP 必須放行 `script-src blob:`**（本實測為此另開了一個 `pblob` 父頁）。Worker 路線不需要。

## CSP：實測可行的最終字串

父頁（靜態字串，Tauri 也寫得出來；`<HASH>` 是 iframe 啟動腳本全文的 sha256，build 時算）：

```
default-src 'none'; script-src 'self' 'sha256-<HASH>'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; worker-src blob:; frame-src 'none'; base-uri 'none'; form-action 'none'
```

iframe（放在 srcdoc 開頭的 `<meta http-equiv="Content-Security-Policy">`，必須在任何 script 之前）：

```
default-src 'none'; script-src blob: 'sha256-<HASH>'; worker-src blob:; connect-src 'none'; img-src blob: data:
```

用 nonce 時把兩邊的 `'sha256-<HASH>'` 換成同一個 `'nonce-<值>'`（啟動腳本帶 `nonce` 屬性）；父頁每次載入都要換 nonce，Tauri 的靜態 `app.security.csp` 做不到，所以建議用 hash。
srcdoc 的 `<script>` 文字必須和雜湊的來源逐位元組相同（換行用 LF，HTML 解析器會把 CRLF 轉 LF）。

說明：
- spec 原文那串 iframe CSP 本身可用，**但只有它不夠**：父頁 CSP 也套在 iframe 上（兩份取交集），所以父頁的 `script-src` 必須放行 iframe 的啟動腳本（同一個 hash 或 nonce）。
- `frame-src 'none'` 不影響 srcdoc iframe 載入，且能擋 iframe 自我導航外洩（見反向檢查）。`default-src 'none'` 的 fallback 本來就是 none，但請不要在 Tauri CSP 裡另外放寬 `frame-src`。
- iframe 加上 `frame-src 'none'; base-uri 'none'; form-action 'none'`（hardened）與 spec 原文在所有檢查上結果相同，目前沒有必要；有加也不影響功能。
- 父頁沒有拿掉 `worker-src blob:` 測過，iframe 的 `script-src` 拿掉 `blob:`（只留 hash）也沒測；這兩條是否可以更嚴還不知道。

## 兩個瀏覽器的差異

- 功能與安全檢查：chromium 與 msedge 完全一致（同為 156 版，Edge 4314、Playwright Chromium 8078）。
- 效能：兩者都用 Intel Arc 內顯的 D3D11，量級相同；msedge 的整張讀回稍慢（35 vs 24 ms／格）、偶有離群值，差異在單次跑的浮動範圍內，不下結論。
- **兩個瀏覽器都是 Playwright 啟動的，帶了它預設的旗標**（`node launch-args.mjs` 印得出完整命令列）：`--no-sandbox`（關 OS 層行程沙盒，不影響網頁平台的 sandbox／CSP）、`--disable-field-trial-config`（用預設功能集，不吃 Google 的實驗設定）、`--disable-background-timer-throttling`、`--disable-renderer-backgrounding`、`--disable-hang-monitor`，以及一串 `--disable-features=…`（Translate、MediaRouter、HttpsUpgrades 等）。清單裡沒有和 Worker、WebGL、CSP、行程隔離有關的項目，沒有關 `IsolateSandboxedIframes`（要關是另外加旗標測的）。所以結論不受影響，但 msedge 這一欄是「Playwright 旗標下的 Edge」，不是原廠設定的 Edge 或 WebView2，退路（行程隔離）那一項尤其要在 Tauri 裡重測。
- headless（SwiftShader）是軟體算繪，每格慢 3～4 倍；而且 headless shell 沒有沙盒 iframe 獨立行程，退路會卡死主頁。它只當對照，不代表 WebView2。
- **msedge 只是 WebView2 的近似**，不等於 WebView2：行程隔離設定、GPU 旗標、CSP（Tauri 的 `app.security.csp`）都可能不同。plan 裡寫的「等 Tauri 骨架後在 WebView2 重載同一頁」還是要做，重點看：①獨立 `iframe` 行程有沒有（退路）；②renderer 是不是 D3D11；③Tauri CSP 下的 nonce／hash。

## 建議改 spec 的地方（只列建議，沒動 spec）

1. §5.7 CSP 那條：補上「srcdoc iframe 的啟動腳本還要通過父頁的 `script-src`」；Tauri 靜態 CSP 用 `'sha256-…'`（建置時算 iframe 啟動腳本雜湊），不是 `'nonce-…'`。blob URL 當啟動腳本不可行（沒有 same-origin 載不到）。
2. §5.7 補上父頁（Tauri `app.security.csp`）的要求：`worker-src blob:`、`frame-src 'none'`（擋 iframe 自我導航外洩，iframe 自己的 CSP 做不到）、`script-src` 不要加 `blob:`（Worker 路線不需要，不加還能防止 Worker 載入其他 blob 腳本）。注意這和第 4 點有取捨：Tauri 是靜態 CSP、用不了 nonce 內嵌，保留「iframe 主執行緒載入 blob: script」的退路就**必須**在父頁加 `script-src blob:`；既然建議把退路降級，這一點以不加為準。
3. §5.7「沙盒載入插件前覆寫 `Math.random`、`Date.now`、`performance.now`」：只覆寫這三個不夠，`new Date()`、`Date.prototype.constructor`、`Intl.DateTimeFormat().format()` 都會漏真實時間（本 spike 的 `public/worker-prelude.js` 已處理）。`performance.mark/getEntries` 與 `event.timeStamp` 沒辦法補，建議把「插件拿不到真實時間」改成「拿不到直接的真實時間；`setTimeout` 忙迴圈之類的間接計時堵不住，可重現性靠插件守規則」。
4. §5.7 退路那段：補上「iframe 主執行緒卡死時主頁會不會被卡，取決於瀏覽器有沒有把沙盒 iframe 放進獨立行程（Chromium／Edge 156 有；headless shell 與關掉 IsolateSandboxedIframes 時沒有、永久卡死）」，並註明退路需要父頁放行 `script-src blob:` 或改成把插件程式用 nonce 內嵌進 srcdoc 重建 iframe。
5. 若採用 direct 模式（把 MessagePort 交給 Worker，畫格不經 iframe 主執行緒），§5.7「逾時直接終止 Worker」要由 iframe 的 runtime 執行 `worker.terminate()`，主頁只能發訊息要它殺；實測這個來回約 1 ms，可行。
6. §5.21／D24 第 (3) 項（5 秒 3D 區段的來回＋讀回）可以引用本實測的數字：硬體內顯上純轉移約 2.5～5 ms／格，加讀回約 18～36 ms／格；軟體算繪 60～95 ms／格。

## 沒測到的

- 真正的 WebView2／Tauri（見上）。
- 記憶體炸彈（Worker 無限配置記憶體）、WebGL 無窮迴圈卡在 GPU 指令（`terminate()` 能不能打斷）。
- iframe 的 `csp` 屬性、`Permissions-Policy`、`credentialless` 之類另一層防護。
- 只在一台機器（Intel Arc 內顯）跑；沒有 NVIDIA／AMD 與純 CPU 的真機。
- three.js 的 OffscreenCanvas 用法只畫了疊加平面；沒測 `TextureLoader`（會用 DOM，不能用）、glTF 載入、陰影等。

## 怎麼重跑（PowerShell 7）

```powershell
Set-Location d:\GitHub\wordblade\spikes\sandbox
npm install                       # playwright-core、esbuild、three
npm run build                     # 把 three.js 插件打包成 dist\three-box.js
node run.mjs                      # 三個環境全跑（chromium 有視窗、msedge 有視窗、chromium headless），約 4 分鐘
node run.mjs --env=msedge-headed  # 只跑指定環境（逗號分隔）
node run.mjs --env=chromium-noisolate   # 只跑退路對照（關閉沙盒 iframe 獨立行程，主頁會卡死，約 10 秒）
$env:FRAMES = 100; node run.mjs   # 改每種模式的格數（預設 300）
node summarize.mjs                # 把 results\*.json 印成對照表
node server.mjs                   # 只開伺服器，手動用瀏覽器看（http://127.0.0.1:<port>/main.html?variant=nonce）
```

需要 Playwright 的 Chromium（`~/AppData/Local/ms-playwright/chromium-1248`）與已安裝的 Edge。`chromium` 與 `msedge` 要有視窗（headed）才會用到真的 GPU。測試時請不要同時跑其他吃 GPU／CPU 的工作，會影響耗時。

檔案：`launch-args.mjs`（印出 Playwright 實際的瀏覽器命令列）、`server.mjs`（主頁伺服器＋誘餌伺服器）、`public/`（主頁 `main.html`、`composer.js` 合成器與測試函式、`iframe-runtime.js` 沙盒內執行環境、`worker-prelude.js`＋`worker-harness.js`＋`probes.js` 是進 Worker 的程式）、`plugins/`（測試插件）、`run.mjs`（Playwright 驅動）、`summarize.mjs`、`build.mjs`。
