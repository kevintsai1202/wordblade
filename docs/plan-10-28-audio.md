# 10/28 AI 音效（P1-8）＋ AI 音樂 WebAudio 版（P1-11）

和 SAM 遮罩平行開發（另一個分支），所以改動收得很窄：不碰合成器、匯出、預覽、時間軸元件與遮罩；App.tsx 只加 `audio:` 子頁籤一行；spec 只改 §5.15。

決定：
- 宣告式音訊（D27）：模型只回 JSON，前端的解讀器建 Web Audio 節點、用 `OfflineAudioContext` 算成 48 kHz 單聲道 16-bit WAV。
- schema 只有一份：`src/audio/synth/synth.schema.json`（入口 `#/$defs/sound`、`#/$defs/music`）。前端與閘道各有一個 JSON Schema 子集的檢查器（`schemaLite.ts`／`SchemaLite.java`，錯誤文字相同），再加 schema 表達不了的語意檢查；`validationCases.json` 兩邊都跑。沒有引入 JSON Schema 函式庫（常見的 Java 實作綁 Jackson 2，閘道用 Jackson 3）。
- 閘道資源檔（schema 複本、兩份提示詞）由 `node scripts/synth/build-prompt.mjs` 從前端的 schema 與範本產生（同 plane3d 的做法）；`gatewaySync.test.ts` 抓忘記重跑。
- 配樂長度用「小節數」（4／8／16），速度由模型選；閘道要求 `bars` 等於請求的值、音效 `length` 等於請求的長度，不合就回饋重問。
- 音高用 MIDI 編號或「和弦的第幾個音」（跟著和弦進行走），鼓用內建鼓組（kick、snare、hat、openhat、clap）。
- 首尾無縫：多算一段尾巴（release、延遲、殘響）再疊回開頭；長度剛好是整數小節。
- 測試的 `OfflineAudioContext` 用 `node-web-audio-api`（devDependency，只有測試用）。
- 沒做 `Project.synths` 紀錄（§4 的 `Synth`）：產生的 WAV 直接當一般素材；要記 spec 以便之後重算再補（見下方未做）。

## 任務

| # | 任務 | 驗收 |
| --- | --- | --- |
| S1 | schema、JSON Schema 子集檢查、語意檢查、和弦與 ADSR、展開成音 | Vitest |
| S2 | 解讀器：Web Audio 節點＋`OfflineAudioContext`、固定種子、配樂尾巴疊回開頭、峰值限制、WAV | Vitest（長度、整數小節、接縫、兩次結果一樣） |
| S3 | 10 個音效範本＋2 個配樂範例；建置閘道提示詞的腳本 | Vitest（範本都合格、能算出聲音；閘道資源同步） |
| S4 | 閘道 `/v1/ai/sound`、`/v1/ai/music`（POST＋GET 輪詢）、解析與驗證、重問一次、用量 | JUnit（解析、工作流程、請求檢查、和前端共用案例） |
| S5 | `Engine.importGenerated`（桌面 Rust `write_generated` 寫 generated/；網頁 File）、`importSources` 回傳素材 | cargo check、Rust 單元測試、e2e |
| S6 | 音效子頁籤：範本、AI 生成、預覽、存素材庫、加到時間軸（A3／A2，範圍起點或播放頭，一次復原）；配樂的再生成一次與改一下；同意說明 | e2e（閘道以 page.route 模擬） |

## 進度

| # | 狀態 | 結果 |
| --- | --- | --- |
| S1 | 完成（10/28） | `synth.schema.json`、`schemaLite.ts`、`spec.ts`；Vitest 48（schemaLite 6、spec 42，含 24 個共用案例） |
| S2 | 完成（10/28） | `render.ts`；Vitest 7（音效長度精確到樣本、配樂整數小節、接縫跳動不大於中段、同 spec 兩次 WAV 位元組相同、換種子不同） |
| S3 | 完成（10/28） | `templateData.json`（whoosh、pop、ding、typing、rise、fall、click、sweep、impact、sparkle；lofi、tech）；`scripts/synth/build-prompt.mjs`；Vitest 2 |
| S4 | 完成（10/28） | `gateway/.../synth/*`；JUnit 44（SchemaLite 5、SynthParser 30、SynthJobs 6、SynthController 3）；閘道全套 81 通過 |
| S5 | 完成（10/28） | `src-tauri/src/generated.rs`；cargo check 無警告、Rust 測試 1 |
| S6 | 完成（10/28） | `SoundTab.tsx`、`ai/synth.ts`（Vitest 4）；e2e `sound.spec.ts` 3 項 |

## 未做／之後

- 實機呼叫 Muse Spark（由 lead 實測提示詞與輸出品質）。
- Windows 版實機點一次（write_generated 寫檔、asset 協定預覽）；目前只有 cargo check 與檔名單元測試。
- `Project.synths`：存 spec 與來源（builtin／ai），重開專案或改設定時可重算；2D 插件引用音效（§5.7）也要它。
- 配樂只放一段（一圈）；選了較長的範圍時可以接著重複放到填滿。
- 網頁版的產生檔和使用者匯入的檔案一樣只在記憶體，重新整理就沒有（存開專案做好後一起處理）。
