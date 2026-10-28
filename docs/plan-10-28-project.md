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
| P3 | 未做 | |
| P4 | 進行中（10/28） | `project/session.ts`（存前補指紋、開時找回素材、最近開啟、匯出預設在資料夾旁；Vitest 4）、`ui/useProjectFolder.ts`、標題列 Save…／Open…／Recent、已儲存時間、找不到的素材提示；開著資料夾時瀏覽器自動存檔停用；匯出對話框預設 `<父資料夾>\<專案名>.mp4`。**還沒做**：桌面 UI 實際點過（WebView2）、重新連結的介面。**待查**：e2e 的外掛沙盒啟動逾時（export／effects／vibe 都失敗，未改動 P4 時也一樣，沙盒程式今天沒動過——疑似環境；11:00 時同樣的 spec 是過的） |
| P5 | 未做 | |
