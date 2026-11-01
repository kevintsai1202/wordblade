# 10/28 專案資料夾（P0 §5.13 存檔；D41）

開發者 2026-10-28 選定方案 B（使用者選位置的專案資料夾），並要求比字導字演扁平：
- 專案是資料夾 `<專案名>.wordblade\`，**看得到的只有 `project.json`**；程式自己管理的資料放隱藏的 `.data\`（遮罩取樣、AI 原始結果、產生的音效與配樂）。
- **匯出不進專案資料夾**：預設存在專案資料夾旁邊（同一層）`<專案名>.mp4`，SRT 跟影片放一起；之後記住上次的位置。不建 `exports\`、`.internal\` 之類的子目錄。
- 素材不複製，用路徑參照：每支記絕對路徑、相對專案資料夾的路徑、內容指紋（大小＋頭尾各 1 MB，照字導字演），搬家後依序找，都找不到就提示重新連結。
- 代理檔、縮圖留在程式快取（可重算，不進專案）。

```
影片們\
├ MyTalk.wordblade\
│  ├ project.json
│  └ .data\        （隱藏）
├ MyTalk.mp4       ← 匯出
├ MyTalk.srt
└ 錄影-1.mp4       ← 素材（路徑參照）
```

## 任務

| # | 任務 | 驗收 |
| --- | --- | --- |
| P1 | `core/projectFile.ts`（純函式）：專案 → project.json（版本、素材參照：絕對／相對路徑、指紋）、讀回（版本檢查、相對路徑換算）；重新連結的候選順序 | Vitest |
| P2 | 桌面（Rust）：建專案資料夾（`.data` 設隱藏）、讀寫 project.json（暫存檔＋改名）、素材指紋、找素材（相對 → 絕對）；Engine `ProjectStore`：new／open／save／最近開啟 | cargo test＋selftest |
| P3 | 網頁：File System Access（選資料夾、資料夾與素材檔案的權限存 IndexedDB，重新整理後點一下同意就接回素材）；沒有 API 時退回現在的 localStorage 自動存檔 | e2e（Playwright 可用 OPFS 當資料夾） |
| P4 | 介面：標題列（專案名稱、New／Open／Save as、最近開啟、「已儲存 HH:MM」）、開著專案時每次編輯後 2 秒存進 project.json；找不到素材的重新連結提示；匯出預設位置改在專案資料夾旁 | e2e |
| P5 | 遮罩取樣、AI 原始結果、產生的音檔搬進 `.data\` | 之後 |

## 進度

| # | 狀態 | 結果 |
| --- | --- | --- |
| P1 | 完成（10/28） | `core/projectFile.ts`：relativePath／joinPath（Windows 與 POSIX、不同磁碟機）、toProjectFile／fromProjectFile（格式名、版本、素材參照）、relinkCandidates；Vitest 5 |
| P2 | 完成（10/28） | Rust `project.rs`（project_create：建資料夾＋`.data` 設隱藏、project_write：暫存檔＋改名＋重試、project_read、media_fingerprint：大小＋頭尾 1 MB FNV-1a、media_locate：依序找＋比指紋＋放行 asset 協定；cargo test 3）；Engine 介面（projectFolders、create／open／reopen／write、mediaFingerprint、locateMedia）桌面實作、網頁先回退；`relinkProject`（Vitest）；WebView2 自我檢查：建立、讀寫、隱藏、指紋、找回素材、錯指紋拒絕 |
| P3 | 完成（11/1） | `WebEngine` 用 File System Access：
- 選資料夾建 `<名>.wordblade` 與 `.data`。資料夾 handle 存進 IndexedDB（`engine/handleStore.ts`），鍵是 `project:<資料夾名>`。
- 「最近開啟」重開時要求權限，需要使用者手勢。
- 開著專案時選檔改用 `showOpenFilePicker`、拖放時取 `getAsFileSystemHandle`，素材 handle 存進 IndexedDB，鍵是 `handleKey`，重開專案時 `locateMedia` 找得回來。用 `<input>` 匯入的列為找不到，可以用 `adoptFile` 重新連結。
- `project.json` 用 `createWritable` 寫。
- 跨平台（11/1）：素材參照多記 `name`，網頁版也算指紋（`core/fingerprint.ts`，和 Rust 同一個 FNV-1a 64）。
  - 桌面版開網頁版的專案：在專案旁邊、專案裡、`.data/generated` 依序找同名檔，再比對指紋。
  - 網頁版開桌面版的專案：只能在授權的專案資料夾與 `.data/generated` 裡用檔名找，同樣比對指紋；專案外面的素材要按「Locate」重新連結，連結時會補上 `handleKey`。
- 素材只記連結、不複製（11/1 開發者決定，同達文西）：匯入時記下原檔路徑或檔案權限，專案資料夾只放程式產生的東西，匯出也放在專案旁邊。
- 原檔找不到時，同樣照達文西的做法處理，不擋使用：
  - 開專案照開，時間軸不動，素材標成 `offline`。這是執行中的狀態，不存進 `project.json`。
  - 素材庫顯示「Media offline · 原本的路徑」，時間軸片段改成紅色斜紋並加上 ⚠。
  - 預覽與匯出在該片段的位置畫「Media Offline」卡（`compositor/offlineCard.ts`），聲音跳過，匯出照樣完成。
  - 按「Locate」重新連結後清掉 offline。e2e 有對應的測項。
- Playwright 接不到這些選取器，`e2e/web-project-folder.spec.ts` 把它們換成 OPFS 的 handle，涵蓋另存、自動存檔、重新整理後重開、重新連結。 |
| P4 | 進行中（10/28） | `project/session.ts`（存前補指紋、開時找回素材、最近開啟、匯出預設在資料夾旁；Vitest 4）、`ui/useProjectFolder.ts`、標題列 Save…／Open…／Recent、已儲存時間、找不到的素材提示；開著資料夾時瀏覽器自動存檔停用；匯出對話框預設 `<父資料夾>\<專案名>.mp4`；重新連結：提示列「Locate <檔名>…」選檔，同資料夾其他遺失素材依原檔名＋指紋一起找回（`relinkMissing`，Vitest 2；WebView2 自我檢查 relinked 2/2）。**還沒做**：桌面 UI 實際點過（對話框無法自動化，留給開發者手點）。e2e 沙盒逾時已查明：iframeRuntime.js 被 autocrlf 轉成 CRLF，srcdoc 解析後是 LF，CSP 雜湊對不上（095870b 修正） |
| P5 | 完成（11/1） | `.data\` 放兩類東西：
- **遮罩取樣**（SAM 的原始結果）放 `masks/<id>.json`，`project.json` 只留 `samplesRef`，格式升到 v2。舊版程式會拒絕讀 v2 的檔案，而不是悄悄丟掉遮罩；讀到 v1 的取樣仍可以直接寫在專案裡。由 `externalizeMasks`、`internalizeMasks` 處理，內容沒變的檔案不重寫。
- **產生的音檔**放 `generated/`，包括 AI 音效、配樂和錄音（Windows 錄音機退路錄的 m4a 也搬進來）。
- 這次沒有其他 AI 原始結果要搬：導演、ASR、Vibe 的結果本來就是專案裡的結構化資料。
- 舊專案指向 `%APPDATA%\generated` 的絕對路徑照舊找得到。
- 讀寫路徑方面，Rust 用 `project_data_write`、`project_data_read`，`data_path` 擋 `..` 與絕對路徑；網頁版用 directory handle。 |
