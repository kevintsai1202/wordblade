# Spring AI × Meta Muse 實測結果（2026-10-27）

版本：Spring Boot 4.1.2、Spring AI 2.0.2（Maven Central 當日最新正式版；4.1.x、2.0.x 都存在）、Java 21。
Spring AI 2.0 的 `spring-ai-openai` 底層是官方 openai-java SDK（4.80.0，OkHttp），**base-url 要含 `/v1`**（`https://api.meta.ai/v1`，SDK 補 `/chat/completions`）；1.x 的寫法（base-url 不含 `/v1`、completions-path 預設 `/v1/chat/completions`）不適用。

方法：`SpikeApp`（ChatClient）的所有請求經本機 `CaptureProxy` 轉給 Meta，存下「實際送出的請求本體」與回應（`logs/capture-*.txt`，base64 已截短、不含 Authorization）。影片素材：`samples/lecture-a.en.mp4` 從 60 秒處切 30 秒、480p（854×480）、每秒 2 格、無聲（62 格、約 54 KB；`prepare-media.ps1`）。模型 ID 與金鑰只從環境變數讀。

## 結論摘要

| 項目 | 結果 |
| --- | --- |
| a. `json_schema` 結構化輸出經 Spring AI | **可行**。`AdvisorParams.ENABLE_NATIVE_STRUCTURED_OUTPUT` ＋ `.responseEntity(Record.class)` 送出真正的 `response_format: json_schema`（`strict:true`），Meta 回 200，`.entity()` 解出 record。預設的 `.entity()` 不送 `response_format`，只把 schema 寫進 prompt，也能用，但多花 ~210 prompt tokens |
| b. 影片 `Media`（video/mp4）經 Spring AI | **形式上送得出、實際上無效：不能用**。Spring AI 2.0.2 把非圖片非音訊的 `Media` 當**文字片段**送（`{"type":"text","text":"data:video/mp4;base64,…"}`），Meta 回 200 但只是把 base64 當文字讀（prompt tokens 49,066 vs 45,487，30 秒與 10 秒幾乎一樣；模型對 10 秒片段回「全黑畫面」＝亂答） |
| b'. 影片本身 Meta 收不收 | **收**，要用 `video_url` 內容片段：`{"type":"video_url","video_url":{"url":"data:video/mp4;base64,…"}}`（直接 REST 實測，回 200、模型能正確描述畫面）。`{"type":"file","file":{"filename":"clip.mp4","file_data":"data:video/mp4;base64,…"}}` 也可（token 數相同）。`input_video` 不認；`image_url` 裝影片會被擋（只收 JPEG/PNG/GIF/WebP/ICO） |
| b''. 退路：關鍵格圖片當多張 image Media | **可行**（走 Spring AI 原生支援）：10 張 480p JPEG（每 3 秒一張）回 200、模型能讀出投影片標題，5,155 prompt tokens（約 515／張） |
| c. 每格 token | **約 130 tokens／格**（Spark，480p、2fps）。10 秒（22 格）prompt 2,878、30 秒（62 格）prompt 8,078（走 `video_url`）；斜率 (8,078−2,878)/(62−22)＝130，截距約 18。Wonder 約 76 tokens／格（1,538 → 4,578）。對照圖片：單張 480p JPEG 約 515 tokens（527 含 ~12 字提示）。2 分鐘一段（240 格）約 31,000 tokens；30 分鐘整支約 468,000 tokens（Spark）。內容是靜態投影片，是否隨畫面內容變動未測（兩組都是同一支片） |
| d. Muse Wonder | **可行**：同樣的 ChatClient 呼叫（一般、原生結構化輸出）都回 200。`@Tool` 工具呼叫 Wonder 與 Spark 都**可用**（`tool_calls` 往返、`proposeCut(12.0,15.5)` 被呼叫、最終回覆 `done`）。Wonder 透過 Spring AI 看影片同樣無效（同 b：只收到 base64 文字，回「無法解碼」）；經 `video_url` 直接送則收得下並描述畫面 |
| e. 耗時 | 見下表；多數 3.5～6 秒，影片 30 秒約 4～6 秒，Wonder 影片 10 秒 ~10 秒 |

## 逐項數據

「上游」是代理量到的 Meta 回應時間；「總計」含 Spring AI 與（首次呼叫的）客戶端初始化。

| 步驟 | 內容 | 結果 | prompt／completion tokens | 上游耗時 |
| --- | --- | --- | --- | --- |
| a1 | Spark，預設 `.entity()`（schema 寫進 prompt） | 200，record 解出 | 263／381 | 5.6 s（總計 9.8 s，含首次初始化） |
| a2 | Spark，原生 `json_schema` | 200，record 解出 | 52／481 | 5.1 s |
| b1 | Spark，Spring AI `Media(video/mp4)` 30 秒 | 200，但影片被當文字 | 49,066／345 | 5.8 s |
| b2 | Spark，Spring AI `Media(video/mp4)` 10 秒 | 200，亂答（全黑畫面） | 45,487／330 | 5.1 s |
| b3 | Spark，10 張關鍵格圖片 | 200，內容正確 | 5,155／421 | 4.1 s |
| b4 | Spark，單張圖片 | 200 | 527／478 | 6.7 s |
| b5 | Spark，Spring AI 影片＋原生結構化輸出 | 200，無效（同 b） | 45,490／419 | 5.5 s |
| d1 | Wonder（reasoning medium）一般呼叫 | 200 | 22／357 | 3.5 s |
| d2 | Wonder，原生結構化輸出 | 200，record 解出（keyPoints 混入「the user is asking me…」這類推理痕跡，品質比 Spark 差） | 52／422 | 5.2 s |
| d3 | Wonder，`@Tool`（兩輪請求） | 工具被呼叫、回 `done` | 1,364／287（第二輪） | 1.7＋1.7 s |
| d4 | Spark，`@Tool`（兩輪） | 同上 | 1,460／543（第二輪） | 1.3＋1.3 s |
| d5 | Wonder，Spring AI 影片 10 秒 | 200，無效（同 b） | 45,487／665 | 10.5 s |
| 直接 REST（`probe-video-director.ps1`，Spark） | `video_url` 10 秒（22 格） | 200，內容正確 | 2,878／702 | 6.4 s（含 PowerShell 與編碼） |
| 同上 | `video_url` 30 秒（62 格） | 200，內容正確 | 8,078／512 | 4.1 s |
| 同上 | `video_url` 30 秒＋`json_schema`（strict） | 200，合格 JSON | 8,086／337 | 4.5 s |
| 直接 REST（Wonder） | `video_url` 10／30 秒、30 秒＋`json_schema` | 200 | 1,538、4,578、4,586 | 6.1／5.1／8.1 s |
| 直接 REST 格式探測（`probe-video-shape.ps1`） | `video_url` 200；`file` 200；`input_video` 400（"did not match any supported type"）；`image_url` 400（"unsupported media type … video/mp4. Supported: JPEG, PNG, GIF, WebP, ICO"） | | video_url 與 file 皆 8,088 | 4.5／5.1 s |

注意：Wonder 的 `json_schema` 影片回覆品質不佳（回了重複、時間超出片長的 issues），Wonder 不適合當逐段看影片的苦工，與 spec D12 的分工一致。Spark 在同一支 30 秒片段回 `issues: []` 並給出正確主題。

## 對 spec 的結論

1. **AI 導演送影片：用 `video_url`，不要用 Spring AI 的 `Media`。** Spring AI 2.0.2 無法正確送影片。做法二選一：(1) 逐段呼叫改用 `RestClient` 直接組 JSON（spec §5.11 已列的退路；`response_format`、`reasoning_effort` 自己加，usage 從回應 `usage` 取）；(2) 用 openai-java SDK 型別。關鍵格圖片退路也可行，但每 3 秒 1 張＝515 tokens，比 6 格影片（約 780）便宜些，資訊量卻少很多，**影片比較划算，建議以影片為主**。
2. **結構化輸出**：`json_schema`（strict）Meta 接受，且經 Spring AI 可用；§6「不支援就改 JSON 模式」的備案可以刪掉。注意要加 `AdvisorParams.ENABLE_NATIVE_STRUCTURED_OUTPUT`，否則 `.entity()` 只走 prompt 內嵌 schema。
3. **Wonder 工具呼叫在 Spring AI 2.0 可用**（§5.11「第一天要實測」的項目通過）；退回方案（全部由 Spark 做）不需要啟動。Spark 也能工具呼叫。
4. **費用估算（Q4）**：Spark 約 130 tokens／格（480p、2fps）；2 分鐘一段約 31k tokens、20～30 分鐘錄影約 310k～470k input tokens，另加逐字稿與輸出。每格 token 數對畫面內容的相依性沒量（素材是靜態投影片），要估費用最好用 10/31 的範例片再量一次。
5. 未測：影片大小／長度上限、Files API、200 MB 以上請求、Muse Wonder 的推理深度對耗時的影響、串流。

## 重跑

```powershell
cd spikes/spring-ai
pwsh -File prepare-media.ps1                      # 產生 media/（clip10、clip30、frames/）
# 金鑰與模型 ID 載入環境變數（不印出）
Get-Content ..\..\.env | Where-Object { $_ -match '^(META_API_KEY|WORDBLADE_MODEL_\w+)=' } |
  ForEach-Object { $k, $v = $_ -split '=', 2; Set-Item "Env:$k" $v }
mvn -q spring-boot:run "-Dspring-boot.run.arguments=--steps=a,b,d" 2>&1 | Tee-Object logs\run.log   # Spring AI 各步驟，擷取在 logs/capture-*.txt
pwsh -File probe-video-shape.ps1                  # 直接 REST：哪種影片片段格式 Meta 收
pwsh -File probe-video-director.ps1               # 直接 REST：每格 token、影片＋json_schema
```

`--steps` 的值是步驟名稱前綴（`a`、`b`、`d`，或 `b3`、`d3` 等）。呼叫總數約 22 次（Spring AI 13 次含工具第二輪、REST 9 次）。
