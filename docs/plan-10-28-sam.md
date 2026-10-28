# 10/28 SAM 3.1 遮罩（P1-5，§5.3）

開發者 2026-10-28 決定先做 SAM、再做 AI 導演（plan-11-02）。原專案 transcript-review 的實作（face_track.py、face_decode.py、face_matte.py、mask_math.py、SamRelay.java）是主要參考。

## 設計決定

- **閘道用輪詢工作，不轉 SSE**：`POST /v1/sam`（multipart：prompt、clip）→ 202 `{jobId}`；閘道在背景上傳 Files API（`purpose=user_data`、`expires_after[anchor]=created_at`、`expires_after[seconds]=3600`，multipart 自己組）、讀 Meta 的串流、把逐格文字解析後累積在工作裡；`GET /v1/sam/{jobId}?after=N` 拿新的格與狀態；`DELETE /v1/sam/{jobId}` 取消（中止上游、刪檔）。理由：Wonder Mesh 的閘道撐不住長時間的單一請求（AiJobs 同理），Zeabur 的 SSE 行為沒量過；遮罩一格只有幾百位元組，輪詢便宜，取消簡單，重試不必重傳。
- **分段＋跨段接續**：閘道 multipart 上限 33 MB（1280 寬、每秒 10 格約 100～280 秒）。範圍長時切成多個請求（靠近換鏡頭就切在換鏡頭，否則約 90 秒），各請求的 SAM id 各自獨立，段與段之間用 IoU ≥ 0.3 接起來（原專案 link_faces）。取樣率（5／10／15）與最大寬度是參數，預設 10／1280；先量一次部署閘道上傳 10 MB 的時間，太慢就改預設 5／960。
- **解碼器授權**：解碼器改寫自 Meta `meta_sam_parser`（SAM License，散布要附全文）。放在獨立檔案 `src/sam/decoder.ts`，檔頭註明出處，`licenses/meta-sam-parser-LICENSE.txt`，§3 第三方授權加一列。
- **換鏡頭**：不用 ffmpeg scdet；把要上傳的小檔用 mediabunny 解成 64 寬，像素差 d ≥ 12 且 d ≥ 3 × max(前 6 格中位數, 後 6 格中位數)（原專案 CutScan），桌面與網頁共用。
- **遮罩存法**：`Project.masks`（素材時間），每個取樣存 `{t, box, payload}`（SAM 編碼字串約 50～300 字，比點陣小得多），用到時解碼、LRU 快取。

## 任務

| # | 任務 | 驗收 |
| --- | --- | --- |
| S1 | 實測：`scripts/sam/probe.mjs`（金鑰從 .env 讀、不印）剪 FOSDEM 約 40 格 640 寬 → Files API → `/v1/responses`（sam-3.1、one_bit）→ 存原始 SSE 到 `src/sam/fixtures/` → 刪檔；記錄有沒有 `[DONE]`、`usage`、費用 | 原始串流檔、實測數字 |
| S2 | `src/sam/`：`stream.ts`（逐格文字解析，任意位置切開結果一樣）、`decoder.ts`（85 字元、one_bit 區間解碼，原專案測試向量）、`cuts.ts`（換鏡頭）、`tracks.ts`（拆段、跨段接續、取最近的取樣） | Vitest |
| S3 | 閘道 `sam/`：工作（上傳、讀串流、累積、刪檔、取消、180 秒閒置逾時）、名詞片語驗證＋`/v1/ai/mask-phrase`（Spark 翻譯，已是合法英文就不呼叫）；用量記格數 | 閘道單元測試（假 Meta，用 S1 的串流） |
| S4 | Engine `makeSamClip(media, start, end, fps, maxWidth)`：桌面 Rust 照搬 cut_clip 的 ffmpeg 參數（重工作鎖）；網頁 mediabunny Conversion（先查 API）；自我檢查加一項 | Vitest／selftest |
| S5 | `Project.masks`＋編輯（addMasks、setMask、deleteMask）；合成器 `drawMasked`（遮罩貼圖用素材座標、和影片同一個 uvRect；馬賽克／模糊／純色，大小依 H/1080；外擴預設框寬 10%）預覽與匯出共用；範圍動作列加 Mask、Mask 子頁籤（目標選項＋自訂、同意說明含 Files API、保留一小時、格數與估價、物件列：開關、效果、強度） | Vitest＋e2e |
| S6 | e2e（假閘道重播 S1 串流：純色效果的預覽與匯出像素）＋實機（本機閘道） | e2e、實機 |

已知限制（不做）：每次請求最多 16 個物件（原專案重送最多 8 輪，這裡只提示 capped）；取樣之間沒有時間平滑。

## 進度

| # | 狀態 | 結果 |
| --- | --- | --- |
| S1 | 完成（10/28） | FOSDEM 講者 person、40 格、1280 寬：小檔 98 KB；上傳 4.1 秒（Files 回應欄位 id、bytes、created_at、expires_at、filename、object、purpose、status）；SAM 第一個位元組 1.4 秒、completed 3.6 秒、25 毫秒後關連線；事件：created、in_progress、output_item.added、content_part.added、40 個 output_text.delta、output_text.done、content_part.done、output_item.done、completed，最後有 `data: [DONE]`；usage 只有 `video_frames_processed: 50`（送 40 格卻記 50，計費可能依此，約 US$0.01）；刪檔 200、3.7 秒。原始串流 `src/sam/fixtures/fosdem-person.sse` |
| S2 | 完成（10/28） | `decoder.ts`（原專案測試向量雜湊相同；字元集要排除反斜線——寫檔時被吃掉一次）、`stream.ts`（任意位置切開相同；實測串流 40 格全部解得開、遮罩尺寸＝框＋1）、`tracks.ts`（換鏡頭、拆段、跨段 IoU 接續、最近取樣）；Vitest 14 |
| S3 | 完成（10/28） | `gateway/.../sam/`：`SamJobs`（上傳 → 讀串流切行 → 完成記用量＝計費格數 → finally 刪檔；取消、上傳失敗 sam-upload、上游錯誤 sam-upstream；同時最多 3 個，再多 429）、`RestMetaSamClient`（java.net.http 讀串流，取消或 180 秒閒置時關串流）、`SamSse`、`SamLines`、`SamPhrase`、`SamController`（POST／GET?after／DELETE /v1/sam、POST /v1/ai/mask-phrase）、Spark 翻譯；設定 `wordblade.models.sam`；閘道測試 10（全部 48 通過） |；本機閘道實測（`scripts/sam/live-local.ps1`→`gateway-check.mjs`）：開機正常；100 格 640 寬小檔 9 秒完成、逐格 100 行、**計費 100 格**（S1 的 40 格記 50 → 推測每次至少算 50 格，估價用 max(50, 格數)）；取消後 0.5 秒變 cancelled；翻譯：車牌→license plate、我的臉→face、「請幫我寫詩」→空字串。取消的工作沒記用量（Meta 可能已處理部分格數）
| S4 | 未做 | |
| S5 | 未做 | |
| S6 | 未做 | |
