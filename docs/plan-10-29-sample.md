# 10/29 範例專案（P0，spec §5.22、D22）

開發者 2026-10-29 決定：
- 素材用已有的合成英文短片 `samples/demo-2min.mp4`（腳本做的畫面＋TTS 旁白，含假 API 金鑰；開發者不自己錄）。
- 內容**實際跑 AI**、存下結果（可重跑的腳本）。
- Windows 版**打包進安裝檔**（離線可開）；網頁版從靜態網站載入。
- 整支片的背景配樂用我們的 **AI 配樂**（P1-11）；片頭用內建配樂。
- 片頭封面圖用 **Muse Image 生成**（每張約 US$0.01）。

## 內容（跟著做完的功能走）

剪輯與字幕（Muse ASR 逐字稿、去贅詞、逐字高亮字幕）、AI 導演建議清單（採用：剪掉重講、遮住假金鑰；其餘留在清單上給評審看）、局部放大、2 個 Vibe特效 2D（Muse Wonder 現寫）、3D 場景（螢幕在桌上）＋吉祥物、翻頁式片頭（Muse Image 封面）、AI 配樂、發佈包（文字＋縮圖）。

## 做法

```
scripts/sample/covers.mjs ──Muse Image generations──► public/sample/covers/*.webp（8 張）
e2e/sample-build.spec.ts（live-local.ps1 -E2E 起本機閘道＋權杖）
   └ 照使用者操作網頁版：匯入 → 轉錄 → 去贅詞 → 導演 → 採用 → Vibe 2D ×2 → 3D → 字幕樣式 → 片頭 → AI 配樂 → 發佈包
   └ 開發用的匯出鉤子（localStorage wordblade.dev=1）：專案 JSON＋程式產生的素材（WAV、PNG）位元組
   └ 寫成 public/sample/：project.json（素材路徑改成 sample/ 相對路徑）、demo-2min.mp4、covers/、generated/
網頁版：首頁／標題列「Try the sample project」→ fetch sample/project.json → 素材網址 /sample/...（不用權杖、不呼叫 AI）
Windows 版：tauri resources 帶 public/sample/ → Engine.sampleRoot() 取資源資料夾並放行讀取 → 路徑改成絕對路徑
```

- 範例專案載入後是「示範狀態」（不自動存、不蓋掉上次的工作）。標題列的 Load demo 換成「Try the sample project」；舊的 `demoProject()`（兩支課程片）只留給 e2e 的 `?demo=1`（drag、layout、preview、session 在用）。
- 線上靜態網站支援 Range（2026-10-29 實測回 206），影片照樣用網址給 mediabunny 分段讀。
- `public/sample/` 會進版控（`samples/` 是 gitignore 的）；demo-2min.mp4 約 9.4 MB。
- 發佈包縮圖不存在專案裡：範例專案另外放一張 `thumbnail.png`，載入時一起放進記憶體。

## 任務

順序（advisor 建議）：先做不呼叫 AI 的最小版範例（逐字稿用 truth.json 的假轉錄、內建 2D 範本、桌上螢幕、逐字高亮），把 S3 載入與離線 e2e 做通——這樣 P0 一定有；再做 S1＋S2 用實際 AI 跑出完整版取代它（每個 AI 步驟失敗就退回內建範本或略過，記在 `public/sample/BUILD.md`）；S4 最後。10/30 晚上 S2 還沒好就先交最小版。

| # | 任務 | 驗收 |
| --- | --- | --- |
| S1 | 封面：`scripts/sample/covers.mjs` 用 Muse Image 生 8 張（程式碼、編輯器、會議筆記、AI 主題，不含字） | 8 張 webp、看過 |
| S2 | 開發用匯出鉤子＋`e2e/sample-build.spec.ts`（實際跑 AI）→ `public/sample/` | 跑完產生 project.json 與素材；記下花費與耗時 |
| S3 | 載入：Engine `sampleRoot()`（網頁：`sample`；桌面：資源資料夾＋放行）、「Try the sample project」按鈕、取代舊 demo | Vitest（路徑改寫）＋ e2e（離線：不連閘道也能開、播放、看到建議清單、匯出） |
| S4 | 安裝檔帶範例（tauri resources）；桌面自我檢查載入範例 | 自我檢查 |

## 進度

| # | 狀態 | 結果 |
| --- | --- | --- |
| S1 | 完成（10/29） | `scripts/sample/covers.mjs`：8 張 Muse Image 封面（9～22 秒／張，都沒有字），存 samples/sample-covers/ |
| S2 | 完成（10/29） | `e2e/sample-build.spec.ts` live：ASR 310 詞、導演 8 條（採用遮金鑰＋剪重講）、去贅詞 3、Vibe 2D ×2、桌上螢幕＋吉祥物、AI 配樂 16 小節、翻頁片頭、發佈包、AI 縮圖；5.4 分鐘；結果見 public/sample/BUILD.md。坑：8 張圖逐張匯入時「處理中」會在兩張之間歸零，要等素材庫有 8 張再產生片頭 |
| S3 | 最小版完成（10/29） | `project/sample.ts`（路徑改寫，Vitest 2）、Engine `openSample()`（網頁 fetch /sample；桌面 Rust `find_sample_dir` 找資源或 repo 的 public\sample 並放行）、標題列「Try the sample project」（取代 Load demo；`?sample=1` 直接開）、開發用鉤子；`e2e/sample-build.spec.ts` 最小版（truth.json 逐字稿、逐字高亮、2D 標題卡＋箭頭、桌上螢幕＋吉祥物）→ public/sample/；e2e `sample.spec.ts`：擋掉所有對外連線仍能開、匯出 2 分鐘（4.4 分鐘，軟體算繪） |
| S4 | 完成（10/29） | tauri resources 帶 `../public/sample/`；正式版安裝檔 73.9 MB；`verify-installer.ps1`：安裝後自我檢查找到安裝資料夾的 sample、16 個素材都讀得到、5 個特效 |
