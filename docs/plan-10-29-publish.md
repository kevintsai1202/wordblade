# 10/29 發佈包（P1-7，spec §5.17、§5.12 縮圖）

開發者 2026-10-29 決定：縮圖這輪一起做；標題、說明、章節用**逐字稿的語言**（介面可改）；`publish.md` 與縮圖**跟匯出的 MP4 放一起**（D41：專案資料夾旁邊），另有「複製」按鈕直接貼到 YouTube。

## Muse Image 實測（2026-10-29，`scripts/publish/probe-image.mjs`）

- `size` 要 `WxH`（`"16:9"` 回 400；原專案筆記寫「長寬比字串」已不成立）；要 1792x1024 實際給 2016×1152，回 `b64_json`（WebP）。
- `/v1/images/generations` 約 14 秒；`/v1/images/edits`（multipart：`model`、`prompt`、`size`、`image`）約 32 秒，輸入約 3.2 萬 tokens。
- 改圖保留畫面主體、加光效；圖裡的字會被改壞（notes-cli → notes-dl），所以標題字由 WordBlade 疊。

## 設計

```
成片逐字稿（timelineWords，成片時間）──► 閘道 POST /v1/ai/publish（Spark，json_schema）──► {titles[3], description, highlights[], chapters[{t,title}], tags[]}
                                                                                      │ 前端整理章節（YouTube 規則）
播放頭這一格（預覽畫布）──► 閘道 POST /v1/ai/image（purpose thumbnail，Muse Image edits）──► 底圖 ──► canvas 疊標題、縮成 1280×720 PNG
                                                                                      │
匯出 MP4 時：有發佈包就同名寫 <名>.publish.md、<名>.thumbnail.png（ExportTarget.writeSibling 擴充成可寫二進位）
```

- 兩個端點都照 locate 的模式：POST 回 202 `{jobId}`、GET 輪詢（Muse Image 要 30 秒，避免代理逾時）；用量照記（Spark tokens、Image 張數）。
- 章節整理（純函式）：先把 Spark 給的秒數對齊到最近的**送出去的行首**（±5 秒內沒有就丟掉，避免模型編時間），再套 YouTube 規則：第一個是 0:00、時間遞增、相鄰 ≥ 10 秒、在成片長度內，少於 3 個就不放。
- 輸入上限：逐字稿超過固定大小時前端從中間截掉（留頭尾）並提示；閘道超過上限回 400。
- 字數上限寫進 schema（`maxLength`）：標題 100、章節標題 60、說明 5000、標籤總長 ≤ 500。
- 縮圖有「不經模型」的路：播放頭這一格＋疊標題（沒有權杖、閘道失敗時也能用；demo 的保險）。標題取使用者選中的那一個，`measureText` 換行最多 2 行、放不下就縮字；中文沒有空白，逐字斷行。
- 沒有逐字稿時頁籤提示先轉錄，不送空的請求。
- 語言：逐字稿 CJK 字元比例判斷（zh／en），介面下拉可改。
- 發佈包文字存在 `Project.publish`（跟著 project.json）；縮圖只在記憶體（重開專案要再產生一次，約 US$0.01）。

## 任務

順序（先讓純文字的發佈包可以 demo，縮圖的 30 秒呼叫不擋文字）：K1 → K2 publish → K4 文字 → K3＋K2 image → K4 縮圖 → 匯出旁檔 → K5。

| # | 任務 | 驗收 |
| --- | --- | --- |
| K1 | `publish/kit.ts`：成片逐字稿行（`[m:ss] 文字`，依停頓分行）、語言判斷、章節整理、YouTube 說明文字、`publish.md` | Vitest |
| K2 | 閘道 `/v1/ai/publish`（Spark json_schema）、`/v1/ai/image`（Muse Image edits） | Spring 測試（假模型）＋ `scripts/publish/gateway-check.mjs` 本機實打 |
| K3 | `publish/thumbnail.ts`：底圖 cover 到 1280×720、疊標題（粗體白字黑描邊、底部漸層） | Vitest（尺寸、版面計算）＋ e2e 看像素 |
| K4 | Export › Publish Kit 頁籤：產生、選標題、改文字、複製；縮圖用播放頭這一格＋風格描述；匯出時寫旁檔 | e2e（假閘道）：產生 → 複製 → 匯出後 OPFS 有 .publish.md、.thumbnail.png |
| K5 | 部署閘道（要開發者同意） | 線上實打一次 |

## 進度

| # | 狀態 | 結果 |
| --- | --- | --- |
| K1 | 未做 | |
| K2 | 未做 | |
| K3 | 未做 | |
| K4 | 未做 | |
| K5 | 未做 | |
