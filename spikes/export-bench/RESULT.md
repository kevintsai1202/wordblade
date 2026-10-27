# 匯出量測：ffmpeg 對 WebGL＋WebCodecs（10/27 實測②，D24 判準）

- 日期：2026-10-27；機器：Intel Core Ultra 5 125H＋Arc 內顯（筆電，無獨顯）
- 素材：`samples/bench-11min.mp4`（678.7 秒，1080p30 H.264＋AAC，英文配音的錄課畫面）
- 合成（兩邊完全相同）：V1＝整支片；子母畫面＝同一支片從 30 秒處開始，480×270 疊在 (1400, 40)；聲音＝主音＋子母畫面 × 0.25；輸出 1080p30 H.264 8 Mbps＋AAC 160 kbps
- ffmpeg 路線：`-filter_complex` 的 scale＋overlay＋amix，軟體解碼、指定編碼器
- WebCodecs 路線：mediabunny 1.62（`VideoSampleSink` 硬體解碼兩路 → WebGL2 合成 → `CanvasSource` 硬體編碼 → `StreamTarget` 串流寫 OPFS），兩路解碼並行且預先解下一格
- 判準：WebCodecs 匯出時間 ≤ 最快 ffmpeg 的 1.5 倍

## 結果（完整 678.7 秒）

| 路線 | 環境 | 秒數 | 即時倍速 | 相對 `h264_qsv` |
| --- | --- | --- | --- | --- |
| ffmpeg `h264_qsv` | — | 136.5 | 5.0× | 1.00 |
| ffmpeg `h264_mf` | — | 177.8 | 3.8× | 1.30 |
| WebCodecs | Edge 156 | 228.9 | 3.0× | 1.68 |
| WebCodecs | **Tauri（WebView2 155）** | **232.3** | **2.9×** | **1.70** |
| WebCodecs | Chromium 156 | 254.3 | 2.7× | 1.86（量測中途有跑單元測試，偏慢） |

- 所有輸出長度都是 678.70 秒、檔案約 440～447 MB，三個瀏覽器環境的 WebGL 都是 Arc 內顯（ANGLE D3D11），不是軟體算繪。
- `VideoEncoder.isConfigSupported`（`avc1.640028`、1080p、`prefer-hardware`）三個環境都是 supported。

## 補充實驗（前 120 秒）

| 變體 | ffmpeg qsv | Chromium | Edge |
| --- | --- | --- | --- |
| 兩路並行解碼＋預解下一格 | 25.9 | 37.0（1.43×） | 39.7（1.53×） |
| 同上，解碼改用軟體 | — | 48.1 | 47.7 |

- 硬體解碼比軟體解碼快，瓶頸不在解碼器選擇；並行解碼對整體影響不大。

## 結論

- **不通過 1.5 倍判準**：WebView2 是 1.70 倍（比 `h264_mf` 慢 1.31 倍）。
- 但這組合成沒有 3D／插件。ffmpeg 退路遇到插件區段時，畫格要經 Rust 以 rawvideo 在 WebView 與 ffmpeg 之間來回（1080p 每秒雙向約 240 MB），原專案的 ffmpeg 3D 匯出量到每 1 秒 3D 多花 2.5～5.5 秒；統一合成器的插件畫格留在 GPU（`spikes/sandbox`：每格 18～36 ms 含讀回）。有特效的片，兩條路的差距會縮小甚至反轉，這部分沒有實測。
- 11 分鐘的片用統一合成器約 3.9 分鐘匯出完（2.9 倍即時），60 分鐘的片估計約 21 分鐘。

## 重跑

```powershell
cd spikes/export-bench
node run-bench.mjs                       # ffmpeg（qsv、mf）＋Chromium＋Edge，完整 11 分鐘
node run-bench.mjs --seconds 120         # 前 120 秒
node run-bench.mjs --only browser --dec prefer-software   # 解碼改軟體
cd ../..; pwsh spikes/export-bench/run-tauri.ps1          # Tauri（WebView2）版，結果在 spikes/tauri-env/RESULT.json
```

原始結果：`output/results-*.json`；跑之前讓機器閒置（不要同時編譯或跑測試）。

## 含 3D 區段（60 秒）（10/27 實測③）

- 設計：時間軸 60～120 秒（1800 格）整段換成 3D 場景「螢幕在桌上」（`src/scene3d.ts`，兩條路共用同一份）：木紋桌面＋16:9 螢幕貼當格的合成畫面（主畫面＋子母畫面），鏡頭 60 秒內從遠線性推近，1920×1080 整張取代該段畫面。其他時間照舊。素材同上（678.7 秒）。
- 路線 A（統一合成器）：合成器畫好主畫面＋子母畫面 → `createImageBitmap(canvas)` → transfer 給專用 Worker（OffscreenCanvas WebGL2 跑 three.js 0.186.1）→ `transferToImageBitmap()` 傳回 → 合成器整張畫上去 → 編碼。逐格串行（沒有跨格重疊）。
- 路線 B（ffmpeg 退路，`spikes/ipc-bench/`，獨立 Tauri 2 小程式）：Rust 開兩個 ffmpeg（解碼端 2 路輸入＋scale＋overlay → rgba rawvideo；編碼端 rgba rawvideo → `h264_qsv` 8 Mbps），前端每格 `invoke('fb_next')`（`tauri::ipc::Response` 二進位回傳）→ ImageData → createImageBitmap → three.js → `readPixels`（上下翻轉）→ `invoke('fb_push', Uint8Array)`（Rust 用 `InvokeBody::Raw` 收）。three.js 放在**主執行緒**算：這條路的瓶頸是 IPC 與 ffmpeg，放 Worker 只會多一趟 ImageBitmap 轉移（2.5～5 ms／格），主執行緒是退路成本的下限，對退路有利。Rust 兩端各有背景執行緒＋深度 4 的佇列，讓 ffmpeg 與前端重疊。
- 環境：Core Ultra 5 125H＋Arc 內顯；Chromium 156、Edge 156（Playwright 啟動）、Tauri WebView2 155（debug 版 wordblade.exe）；WebGL 都是 Arc（ANGLE D3D11），Worker 內的 WebGL 也是。每項各跑完整一次，機器閒置、同一時間只跑一個量測。

### A. 統一合成器：含 3D 的完整匯出（678.7 秒素材，輸出長度皆 678.70 秒）

| 環境 | 含 3D 全片（秒） | 同一時段不含 3D 全片（同期重跑，秒） | 60～120 秒區段：含 3D（秒） | 同區段不含 3D（秒） | 3D 多花（秒） | 3D 每格多花（ms） |
| --- | --- | --- | --- | --- | --- | --- |
| Chromium 156 | 215.7 | 199.2 | 26.4 | 16.5 | 9.9 | 5.5 |
| Edge 156 | 215.9 | 215.4 | 26.7 | 18.7 | 8.0 | 4.4 |
| **Tauri（WebView2 155）** | **254.9** | 223.9 | 31.4 | 19.2 | 12.2 | 6.8 |

- 3D 區段只多花 8～12 秒（每格 4～7 ms，大半被編碼器與合成器的 GPU 工作重疊掉了）。全片「含 3D 比不含 3D 的同期重跑只多 0.5～31 秒」是機器浮動（同一環境前後兩次不含 3D 就差 8%：Edge 228.9 → 215.4），看區段的差（右兩欄）比看全片可靠。
- 每格分項（CPU 側計時，ms／格，Edge）：`createImageBitmap` 0.15、送進 Worker 到收回 0.83（Worker 內 render＋transferToImageBitmap 0.5）、整張畫回合成器 0.04。**這些只是命令發出的時間，GPU 真正的工作都沒被算進去**（`gl.finish()` 在 Chromium 幾乎不阻塞；讀 1 像素強制同步的診斷版量到：合成 5 ms、Worker 畫 3D 8 ms、畫回 3 ms，共約 16 ms，但同步會破壞重疊，不能當總耗時）。真正的耗時看區段總秒數。
- 3D 區段耗時主要出現在 `videoSource.add`（等編碼器取格與 GPU），這是 GPU 排隊，不是 IPC。

#### 一個實測踩到的坑：螢幕貼圖的色彩空間
第一版 `screenTexture.colorSpace = SRGBColorSpace`（貼圖格式 SRGB8_ALPHA8）時，ImageBitmap 上傳每格多花約 **40 ms**（Chromium，10 秒區段 3D 15.9 秒，對照不含 3D 2.5 秒；關 MSAA 沒差、不更新貼圖則降到 5 ms／格）。改成 `NoColorSpace`（RGBA8）＋原樣輸出的 `ShaderMaterial` 後降到 3.2～3.8 秒。畫面本來就是 sRGB 值，原樣貼上不需要色彩轉換。**spec 的 3D 範本與 Vibe特效的 3D 插件文件要寫明：把 ImageBitmap 貼進 three.js 時用 `NoColorSpace`**，否則每格會多 40 ms、60 秒 3D 多 40 秒以上。診斷版原始檔在 `output/diag/`（`?s3dSrgb=1` 可重現舊寫法）。

### B. ffmpeg 退路：3D 區段實測（60 秒、1800 格，Tauri 2 release 版；debug 版 90 格測試每格數字相同，IPC 不受建置模式影響）

| 迴圈 | 3D 區段實測（秒） | 每格總計（ms） |
| --- | --- | --- |
| 逐格串行（任務指定寫法） | **549.7** | 305 |
| 管線化（算第 i 格時預取第 i+1 格、送格不等回應） | **410.0** | 228 |

每格分項（ms，平均）：

| 步驟 | 串行 | 管線化 |
| --- | --- | --- |
| IPC 取格（`fb_next` → 前端拿到 8 MB ArrayBuffer） | 111.5 | 221.7（和送格搶頻寬，變兩倍） |
| createImageBitmap（ImageData → ImageBitmap） | 5.1 | 5.8 |
| 渲染＋`readPixels` 讀回 | 17.2 | 21.4 |
| 上下翻轉（JS 逐列複製） | 1.2 | 1.5 |
| IPC 送格（`fb_push` 前端送出到 Rust 回應） | 170.4 | 0（不等，和下一格重疊） |

- **Rust 端自己只花很少**：`fb_next` 在 Rust 內 0.24 ms（佇列裡已有畫格，ffmpeg 解碼沒拖後腿）、`fb_push` 在 Rust 內 2.8 ms（含複製 8 MB）。所以約 110 ms 與 170 ms 是 **Tauri／WebView2 的 8 MB 二進位 IPC 傳輸本身**（約 75 MB/s 取、50 MB/s 送），不是 ffmpeg、不是算繪。
- 解碼端與編碼端 ffmpeg 都以 exit 0 結束；`seg-3d.mp4` 為 H.264 1920×1080、60.000 秒、1800 格。
- 串接（`concat` 複製串流）：用 64 MB 的三段實測 0.3 秒，依檔案大小換算整片（約 440 MB）約 2 秒。這是估算。
- **退路完整匯出估算**（估算，不是整支實跑）＝ ffmpeg qsv 無 3D 全片 136.5 × (618.7／678.7) ＝ 124.4 ＋ 3D 區段實測 ＋ 串接約 2：
  - 串行：124.4 + 549.7 + 2 ≈ **676 秒**
  - 管線化：124.4 + 410.0 + 2 ≈ **536 秒**

### C. 兩條路對照（678.7 秒素材、60 秒 3D）

| 路線 | 完整匯出秒數 | 對 WebView2 統一合成器 | 3D 區段秒數（60 秒） | 3D 區段即時倍率 |
| --- | --- | --- | --- | --- |
| 統一合成器 Edge 156 | 215.9 | 0.85× | 26.7 | 0.45× |
| 統一合成器 Chromium 156 | 215.7 | 0.85× | 26.4 | 0.44× |
| **統一合成器 Tauri（WebView2）** | **254.9** | 1.00× | 31.4 | 0.52× |
| ffmpeg 退路（管線化，估算） | 536 | 2.10× | 410.0 | 6.8× |
| ffmpeg 退路（串行，估算） | 676 | 2.65× | 549.7 | 9.2× |

- 無 3D 時 ffmpeg 是統一合成器的 0.59 倍（136.5 對 232.3），加了 60 秒 3D 之後反過來，統一合成器只要退路的 38～48%。
- 反轉點（估算）：每秒 3D 多花的時間，退路約 6.6（管線化）～8.9（串行）秒，統一合成器約 0.2 秒；無 3D 時統一合成器多花 95.8 秒，所以片子裡 3D 超過約 11～15 秒就反轉。

### 抽格確認
- 路線 A：Chromium 與 Tauri 各用 `--snap`（短區段）存 3D 區段前一格與三格 3D 畫面（`output/snap-chromium-*.png`、`output/snap-tauri-smoke-*.png`）：木紋桌面、螢幕貼的是當格畫面（含右上角子母畫面）、方向正確（沒有上下顛倒）、鏡頭隨時間推近（早／中／晚三格螢幕逐漸變大）。
- 路線 B：從編碼後的 `spikes/ipc-bench/output/seg-3d.mp4` 抽中間一格（`seg-3d-mid.png`）與前端存的抽樣畫格（`snap-b-3d-*.png`）：3D 場景方向正確、畫面和路線 A 同款，確認 readPixels 翻轉無誤、經 h264_qsv 編碼後畫面正常。

### 讓比較不公平的因素
1. 機器浮動：同一環境不含 3D 的兩次全片差 8%（Edge 228.9／215.4）；Chromium 與 Edge 的差別在浮動範圍內。看「區段差」較準，全片數字當量級。
2. 退路是估算：只實跑了 3D 的 60 秒；非 3D 部分用先前的 136.5 秒按比例縮、串接用小檔換算。退路的 ffmpeg 全片基準含音訊混音（amix），3D 區段的測試沒有音訊（只多算幾秒）。
3. 路線 B 的 three.js 在主執行緒，沒有 Worker 轉移成本，對 B 有利；A 逐格串行、沒有做跨格管線化，對 A 不利（A 還有重疊空間）。
4. B 的 IPC 數字是 Tauri 2 預設二進位 IPC（custom protocol）；沒試過換傳輸方式（例如本機 WebSocket／localhost HTTP、共用記憶體），那些可能比 75 MB/s 快，但已不是任務指定的作法。
5. B 的解碼端是 ffmpeg 軟體解碼＋CPU 的 scale／overlay／rgba 轉換，與路線 A 的硬體解碼＋GPU 合成不同，這是兩條路本質上的差別，不是不公平。編碼端 rgba → qsv 由 ffmpeg 的 swscale 轉 nv12（CPU）。
6. 只在一台機器（Intel Arc 內顯、無獨顯）；A 的 3D 區段成本很小，是因為 GPU 工作與編碼器重疊，換成 GPU 較弱或軟體算繪的電腦（spec §5.21 的 720p 退路）結果會不同；B 的 IPC 瓶頸則與 GPU 無關。
7. 場景是簡單的桌面＋螢幕＋兩個小物件（8 ms／格 GPU）；複雜場景（陰影、模型）會拉高 A 與 B 兩邊的算繪成本，但不改變 B 的 IPC 瓶頸。

### 對 D24 的看法（只列建議，沒動 spec）
- 含 3D 後數字清楚偏向統一合成器：WebView2 全片 255 秒，退路估算 536～676 秒（2.1～2.7 倍慢），退路的瓶頸是 Tauri IPC 傳 8 MB 畫格（每格往返約 280 ms），不是 ffmpeg。無 3D 的 1.70 倍落差，在 3D 超過約 15 秒的片子上就反轉。
- 建議保留 D24（統一合成器），把 1.5 倍判準改成「含 3D 或插件的代表性片子」來看；退路只在「完全沒有 3D／插件」的匯出才比較快，不值得維護兩套程式。
- spec 要補的實作要點：ImageBitmap 貼圖用 `NoColorSpace`（否則每格多 40 ms）；3D 區段的耗時是 GPU 排隊，進度條與逾時（§5.7 每格 100 ms 預算）要用 transfer 完成而不是命令發出來量。
- 若日後退路仍要保留：IPC 要改傳輸方式（先量再說），或 3D 區段改在 WebView 內以 WebCodecs 編碼（變成統一合成器）。

### 重跑
```powershell
cd spikes/export-bench
node run-bench.mjs --scene3d                    # 含 3D（60～120 秒），Chromium＋Edge，約 8 分鐘
node run-bench.mjs --seg                        # 對照組：不含 3D，但量 60～120 秒區段耗時
node run-bench.mjs --scene3d --s3d 5,15 --seconds 20 --snap --browsers chromium   # 驗證流程，存抽樣畫格 PNG 到 output/
cd ../..
pwsh spikes/export-bench/run-tauri.ps1 -Scene3d -Tag 3d      # WebView2 含 3D（會覆蓋 spikes/tauri-env/RESULT.json，先備份）
pwsh spikes/export-bench/run-tauri.ps1 -Seg -Tag seg         # WebView2 對照組
pwsh spikes/ipc-bench/run-ipc.ps1 -Build                     # 建置 ffmpeg 退路量測程式（debug）；release 版：cd spikes/ipc-bench; $env:CARGO_TARGET_DIR='D:\GitHub\wordblade\src-tauri\target'; npx tauri build --no-bundle
pwsh spikes/ipc-bench/run-ipc.ps1 -Release -Tag full-serial  # 退路 3D 區段 60 秒，串行；-Pipe 為管線化；-Frames 90 -Snap 為驗證
```
原始結果：`spikes/export-bench/output/results-3d-*.json`、`results-seg-*.json`、`results-tauri-*.json`、`spikes/ipc-bench/output/result-*.json`；建置與執行記錄在 `logs/ipc-bench-*.log`、`logs/export-bench-*.log`。
