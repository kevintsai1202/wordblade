# 10/28 AI 導演（P1-1，§5.11）

開發者 2026-10-28 決定：
- 影像照規格：480p、每秒 2 格、無聲的影片，依逐字稿的停頓約 2 分鐘一段，逐段上傳。
- Muse Wonder 用**結構化 JSON** 一次回建議陣列（取代規格寫的 `@Tool` 工具呼叫；沿用 AiJobs「不合格帶錯誤重問」）。
- 「運鏡」建議由 **Wonder 挑 3D 場景**（建議裡帶場景 id），採用時加那個場景；漂浮板子再交給「用說的」。
- 「加特效」採用時才跑 Vibe。
- 驗收先用模擬短片 `samples/demo-2min.mp4`（有正確答案：假金鑰、語助詞、重講）與 lecture-a，開發者自己的 20～30 分鐘錄影之後再做人工驗收（有用比例 ≥ 60%）。

## 設計

- **桌面**：沒有逐字稿先跑 ASR（現有 TranscribePanel 流程）；依詞的停頓切段（90～150 秒，盡量切在最長的停頓）；每段用 mediabunny 轉 480p（高 480、寬依比例取偶數）、每秒 2 格、無聲、固定位元率（約 250 kbps，2 分鐘約 4 MB）——和 SAM 小檔共用轉檔程式；連同那段的詞（id、時間、文字）上傳。
- **閘道** `/v1/ai/director`：
  - `POST` 建工作（素材名稱、片長、段數）→ `POST …/{id}/segments/{i}`（multipart：video、words JSON）→ 收到就交給 Muse Spark（最多 4 段同時；RestClient 直接組 `video_url` 的 JSON，Spring AI 的 Media 送不了影片），回結構化段落報告：摘要、重講與口誤、隱私項目（時間、名詞片語、大概位置）、適合強調的時刻（特效／放大／運鏡＋描述＋位置）、疑似聽錯的詞（詞 id、應為）。
  - 全部段落回來後交給 Muse Wonder（推理 medium）：全片摘要＋各段報告＋場景清單 → `{suggestions:[{kind, start, end, reason, payload}]}`；閘道驗證（時間在片長內、種類與欄位、每種上限、同種重疊合併、總數 ≤ 60），不合格帶錯誤重問一次。
  - `GET …/{id}` 輪詢（段落進度、建議）、`DELETE` 取消。用量記 token。
- **建議**：存進 `Project.suggestions`（素材時間）；payload：cut `{}`、mask `{target}`、effect `{description}`、camera `{scene, description}`、fix `{wordIds, text}`、zoom `{cx, cy, w}`。
- **採用**（每次一筆可復原的編輯）：cut → `cutSourceRanges`；fix → `editWords`；zoom → 放大區段（建議的中心與框寬）；mask → 對那段跑 SAM（同意說明）；effect → 那段跑 Vibe 2D；camera → 加 Wonder 挑的 3D 場景範本，漂浮板子另跑「用說的」。略過只改狀態。
- **介面**：AI Director 頁籤——選素材、估價（Spark 約 130 tokens／格＋Wonder）、同意說明（Contributor 版內容可能被用於訓練）、Ask the director、段落進度、建議清單（依時間；點一條跳過去；Enter 採用、Esc 略過；已採用／略過的標示）。

## 任務

| # | 任務 | 驗收 |
| --- | --- | --- |
| R1 | 純函式：切段（依停頓）、建議驗證與合併（前後端同規則）、素材時間 ↔ 時間軸、各種採用的編輯（cut、fix、zoom） | Vitest |
| R2 | 閘道：DirectorJobs（段落並行、Spark 影片呼叫、Wonder 統籌、驗證與重問、取消、用量）、Controller、提示詞資源 | 閘道單元測試（假模型）＋本機實機 |
| R3 | 桌面：轉 480p 小檔（共用 SAM 的轉檔）、上傳流程（可取消）、Director 頁籤、採用動作（含 SAM、Vibe、3D） | Vitest（流程用假閘道）＋e2e（假閘道） |
| R4 | 實機：demo-2min（假金鑰要被找成 mask、重講被找成 cut）、lecture-a；計時與 token | 實測數字記進 §5.11 |

## 進度

| # | 狀態 | 結果 |
| --- | --- | --- |
| R0 | 完成（10/28） | 實測（`scripts/director/probe-segment.mjs`，demo-2min 整支 108 秒）：Spark 一次看完 480p、每秒 2 格的 base64 影片（250 kbps 264 KB／150 kbps 236 KB，畫面靜態所以很小），prompt 28,136 tokens（約 130／格）、回應 10.5 秒；**假金鑰在 31 秒被找到**（正確答案 31.4 秒），連螢幕上的程式碼都讀得出來；60 秒那段 15,656 tokens、13.7 秒。WebView2 轉檔（selftest `directorClip`，lecture-a 前 120 秒 → 852×480、2 fps、250 kbps，約 3 MB）：**原檔 39 秒（0.33 倍即時）、540p 代理檔 8.8 秒（0.07 倍）** → 桌面有代理檔就從代理檔轉，網頁從原檔（30 分鐘約 10 分鐘），轉下一段和 AI 看上一段同時進行 |
| R1 | 完成（10/28） | `director/segments.ts`（依停頓切段 90～150 秒）、`director/suggestions.ts`（suggestionSpan、adoptEdits：剪／改字／放大＋狀態同一筆、clampSuggestions）、`core/suggestions.ts`＋編輯 setSuggestions／setSuggestionStatus；Vitest 11 |
| R2 | 完成（10/28） | `gateway/.../director/`：`DirectorJobs`（建工作 → 逐段收、Spark 背景看（JSON 讀不出重試一次）→ 全部回來換素材時間交 Wonder → `DirectorRules` 檢查不合格回饋一次；段落失敗照樣統籌、全失敗才失敗；取消；影片用完即丟）、`RestSparkVideoClient`（video_url＋json_schema strict）、`DirectorRules`（時間、各種類欄位、場景與詞 id、同種重疊合併、上限）、Controller、Config（同時 4 個）、提示詞資源；閘道測試 9（全部 101）。本機實測 `scripts/director/gateway-check.mjs`（demo-2min 一段）：24.7 秒完成；**假金鑰 → mask「API key」30.5～42.8 秒（答案 31.4～43.0）、重講 → cut 49.3～54.2 秒（答案 49.3～54.6）**，另有 zoom（小字終端機指令）與 effect（摘要結果） |
| R3 | 未做 | |
| R4 | 未做 | |
