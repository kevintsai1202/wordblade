# WordBlade 規格書

日期：2026-10-26。狀態：**定案**（§0 全部已回覆；2026-10-26 晚做過一次整份 review，修正前後不一致之處；2026-10-27 依 `spec-review-2026-10-26.md` 修訂，新增 D24～D30）。
活動：Meta Global AI Developer Hackathon（Indie Developer track，主題 Build for Your World）。開發期 10/26～11/4，提交截止 **11/4 21:00 ET（台灣 11/5 10:00）**。
報名時的構想照抄在 §1；本文件是把構想落成可以執行的規格。

## 0. 決定

**已定（開發者 2026-10-26）**

| # | 項目 | 決定 |
| --- | --- | --- |
| D1 | 桌面框架 | Tauri 2 ＋ React 19 ＋ TypeScript（Vite） |
| D2 | AI 金鑰與額度 | 精簡 Spring AI 閘道保管金鑰與每人額度（報名寫的架構）；額度依 D29 在黑客松期間不設上限，只記錄用量 |
| D3 | 介面語言 | 先做英文；字幕斷句以英文為主（中文照樣能轉錄與上字幕，但斷句規則以英文調） |
| D4 | repo | `kevintsai1202/wordblade` 私有，提交前公開 |
| D5 | 開工 | 10/26 只寫規格；程式從開幕（台灣 10/27 00:00，12PM ET／9AM PT 直播）後開始寫 |
| D6 | 參考 | 參考作者先前做影片工具的經驗與設計文件（踩過的坑、API 實測數據）；程式在本 repo 從頭寫 |
| D7 | 不做的輸出（2026-10-26 追加） | 不做 FCP7 XML 匯出；不做簡轉繁（ASR 回什麼就用什麼） |
| D8 | 加入的特效（2026-10-26 追加） | 動畫插件、Vibe特效（AI 寫動畫插件）、平面轉 3D（含「用說的」）、B-roll、轉場；B-roll 依 D14 併進疊加軌（P0），轉場依 D13 降為 P2 |
| D9 | 判斷用什麼模型（2026-10-26 追加） | 不用 Jev；所有「判斷」都交給 LLM（依 D12 分工），例如 Vibe特效擋掉無關或危險的要求、校稿候選、字幕斷句有疑慮時的取捨 |
| D10 | 閘道（2026-10-26 追加） | 照報名稿維持 Spring AI 閘道；AI 任務（校稿、Vibe特效、3D 用說的、遮罩轉名詞片語）的提示詞與結構化輸出都放在閘道，用 Spring AI 做（§6）；ASR、SAM、TTS 用 `RestClient` 轉送 |
| D11 | 頭號亮點（2026-10-26 追加；D19 之後改為第二亮點） | **AI 導演**：Muse 看整支錄影（影片＋逐字稿），列出剪輯建議（重講口誤、畫面上的隱私資訊、適合加特效或運鏡的段落），逐條採用（§5.11） |
| D12 | 模型分工（2026-10-26 追加） | **Muse Wonder 統籌**（AI 導演的規劃與工具呼叫）；**Muse Spark 1.3 做苦工**（逐段看影片、校稿、產生 3D 關鍵幀、遮罩轉名詞片語）；寫動畫插件依 D31 改由 Muse Wonder 做；**Muse Image** 產生 3D 背景與影片縮圖 |
| D13 | 範圍取捨（2026-10-26 追加） | 轉場降為「P1 做完才做」（P2）；Fish 語音修補原列 P3，依 D18 升為 P2；B-roll 依 D14 併進多軌時間軸的疊加軌（P0）；校稿併進 AI 導演的建議清單 |
| D14 | 以剪輯為主（2026-10-26 追加） | **素材庫＋多軌時間軸**：匯入多支影片、圖片、音樂、音效，排在 V1 主軌、V2 以上的疊加軌、A 音軌；WordBlade 自己做不出來的效果（例如 3D 吉祥物）在外部做成影片素材（可帶透明）放進來用（§5.13） |
| D15 | 音軌與介面（2026-10-26 追加） | 影片放上時間軸時，聲音直接分離成 A 軌上獨立的片段（不連動）；介面以單一畫面為主、不做區塊收放與模式切換，力求功能完整（§5.13）；版面依 D33 |
| D16 | 聲音分離（2026-10-26 追加） | 素材的聲音可以拆成人聲與背景音樂兩個獨立片段（MDX-Net ONNX，本機執行），P1（§5.14） |
| D17 | 3D 用 three.js（2026-10-26 追加） | Vibe特效除了 2D 插件，也能讓模型寫 three.js 的 3D 插件，可以讀當格畫面、定位點、逐字稿與音量，和影片互動；「平面轉 3D」改成 three.js 的內建範本（螢幕在桌上＋鏡頭運動），不做 CSS `matrix3d`＋ffmpeg 四角映射那條路（§5.7、§5.8） |
| D18 | 音訊（2026-10-26 追加） | AI 音效獨立生成（P1）；AI 音樂先做 WebAudio 版（P1），Meta MusicGen 列 P2（權重 CC-BY-NC，只限黑客松使用）；AI 重生語音升為 P2（Fish Audio，樣本取分離後的人聲）；人聲／音樂／音效三軌拆分與 Meta Demucs 先實測，分不出來就維持兩軌（§5.6、§5.14、§5.15） |
| D19 | 核心（2026-10-26 追加） | **核心是 Vibe特效（含 3D）**：2D／3D 插件、Vibe特效、3D 場景＋用說的升為 P0，排在剪輯骨架之後最先做；demo 開場也以它為主 |
| D20 | 追加功能（2026-10-26 追加） | 一鍵去贅詞、發佈包（標題／說明／章節／縮圖）、逐字高亮字幕＋重配錄音卡拉 OK 模式、局部放大（含路徑關鍵幀）、片段變速（demo 要用）、定格、轉場（§5.16～§5.20）；依 §2 的取捨順序做 |
| D21 | 網頁版＋Windows 版（2026-10-26 追加） | 兩版同時做、共用同一套介面、TS 核心、沙盒與閘道。**效能優先，執行環境只有 CPU**（使用者電腦沒有獨立顯卡、最多有內顯；Zeabur 伺服器也沒有 GPU）：Windows 版是主力，重運算走原生程式（ffmpeg、onnxruntime；匯出依 D24 走 WebCodecs 硬體編碼）；網頁版給評審試用與短片剪輯（§5.21） |
| D22 | 範例專案（2026-10-26 追加） | 內附範例專案、一鍵開啟：2 分鐘片段，逐字稿、遮罩、AI 導演建議、Vibe 2D／3D 特效都預先算好；評審在網頁版不用權杖、不呼叫 AI 就能看完整流程；內容跟著實際做完的功能走（§5.22） |
| D23 | 伺服器（2026-10-26 追加） | **伺服器只跑 AI 服務**（Spring AI 閘道＋它的 PostgreSQL），不做任何媒體處理；剪輯、代理檔、聲音分離、匯出全部在使用者端。網頁版是靜態檔案，和閘道分開成獨立服務（2026-10-27 開發者改定：放 Zeabur 神奇網路主機，不用 Cloudflare Pages，§5.21） |
| D24 | 統一合成器（2026-10-27，review A3） | 預覽與兩版匯出都用**同一個 WebGL 合成器**；匯出用 WebCodecs 編碼、mediabunny 封裝。ffmpeg 只負責代理檔、把 WebCodecs 解不了的格式轉成中間檔、抽 ASR 音訊。遮罩、局部放大、3D、轉場、字幕只寫一次（§5.4）。**定案（10/27 實測後，開發者）**：沒有 3D 時比 ffmpeg qsv 慢 1.7 倍，但含 60 秒 3D 時比 ffmpeg 路線快 2.1～2.65 倍（ffmpeg 路線的插件畫格卡在 Tauri IPC），所以維持統一合成器、不做 ffmpeg 匯出退路（§5.4） |
| D25 | 漣漪的跨軌規則（2026-10-27，review A1） | 比照 Resolve：V1 漣漪刪除時，所有未鎖定軌一起處理，鎖定軌不動（§4） |
| D26 | 字幕由逐字稿算出（2026-10-27，review A2） | 字幕不另存文字，是「Words＋斷句規則＋斷點 override」的純函式；手改字幕就是改 `Word.text`（§4） |
| D27 | AI 音效與音樂改宣告式（2026-10-27，review C2） | 模型回宣告式 JSON（振盪器、雜訊、濾波器、包絡、音符表），由我們的程式解讀並用 `OfflineAudioContext` 算成 WAV；不執行模型寫的音訊程式（§5.15） |
| D28 | 聲音分離只跑一個模型（2026-10-27，review C5） | 只跑人聲模型，背景音樂＝原音減人聲；網頁版不做聲音分離，提示改用 Windows 版（§5.14） |
| D29 | 不設額度上限（2026-10-27，review C3 開發者改定） | 黑客松 demo 以能順利操作為優先：**不設每人與全站的用量上限**。保留的：權杖驗證、逐筆用量紀錄（`GET /v1/me` 可查）、可停用權杖；單次請求的大小、逾時、素材長度等安全限制照設（那是防濫用，不是預算）（§6） |
| D30 | 範例素材提前錄（2026-10-27，review A5） | 10/31 錄一段 2 分鐘英文短片（含假 API 金鑰），同一支片當 ASR 英文實測、贅詞實測與範例專案的素材；11/3 只做範例專案打包（§5.22） |
| D31 | Vibe特效用 Muse Wonder（2026-10-27） | Vibe特效（2D／3D 插件的撰寫與錯誤回饋重寫）改用 **Muse Wonder**（推理深度 medium）：它是核心（D19），程式品質比速度重要。Wonder 不穩或拿不到時退回 Muse Spark 1.3（模型 ID 走設定，不改程式）。3D「用說的」、校稿等其他任務照 D12 用 Spark（§5.7、§6） |
| D32 | 模型版本（2026-10-27） | Muse Spark 全部用 **Contributor 版**（`muse-spark-1.3-contributor`）；Muse Wonder 只有 Standard 版（`muse-wonder-1.0`）。Fish Audio 一律用免費模型 `s2.1-pro-free`。模型 ID 放在設定（`WORDBLADE_MODEL_*` 環境變數），不寫死在程式。同意對話框註明 Contributor 版的內容可能被用於訓練（§3、§5.11） |
| D33 | 介面照原專案的混合模式（2026-10-27） | 版面直接參考作者先前專案（SubTutor）的「混合」工作模式：上方標題列、左側大預覽＋播放控制、右側編輯面板（分組頁籤）、下方多軌時間軸、最底下熱鍵提示列。只做這一種版面，不做影片／字幕模式切換（§5.13） |
| D34 | 一鍵片頭（2026-10-27） | 開發者要求列入：使用者給多張封面圖＋標題（＋icon、可選自己的音樂），一鍵生成片頭——快速翻頁、閃光後閃入字卡加 icon，附翻頁與轉場音效和配樂；另外蒐集多種片頭風格，目的是快速產生片頭。調查見 `docs/research/intro-styles.md`；功能見 §5.23（P1-12） |
| D35 | 2D 插件沿用原專案直譯器（2026-10-27） | 開發者選定：2D 插件用原專案（字導字演）的元件格式、受限 JavaScript 與直譯器（`draw(g, t, p, env, bg)`，原生 JS `render(ctx, …)` 不採用），直譯器放進沙盒 Worker 執行（雙層防護）；元件庫、API 說明、提示詞與 202 項測試一併沿用。3D 插件仍是沙盒 Worker 裡的原生 JS（§5.7） |
| D36 | Muse Image 材質圖（2026-10-27） | 開發者選定：一句話產生**無縫材質圖**，用在內建 3D 場景表面、3D 插件（含 Vibe特效 3D）、2D 插件填色與 3D 背景；Muse Image 只產生顏色圖，**無縫化、去暗角與法線貼圖由 WordBlade 本機算**（不多花錢）；排 P1-14（11/3 做到哪算哪），併入 §5.12 |
| D37 | 字幕自己用 Canvas 2D 畫（2026-10-28） | 開發者選定：取代原訂的 JASSUB（libass WASM）。預覽與匯出用同一個 `CaptionLayer`（`src/captions/`）畫在合成器最上層；三種外觀（描邊／底色塊／陰影，另有「不燒進畫面」）＋逐字高亮（填色／放大／底色），完全可控、好測，沒有 WASM 整合風險；不支援任意 ASS 特效（用不到）。字型隨程式打包：英文 Inter、中文 Noto Sans TC（OFL，中文分塊、用到的字才載入），預覽與匯出一致 |
| D38 | 局部放大與特效照字導字演的做法（2026-10-28） | 開發者要求：先在時間軸框選範圍（Shift＋拖曳，以播放頭為錨點；I／O 也可）→ 範圍上方的動作列建立放大或特效。局部放大改成**區段**（`Project.zooms`：素材時間的起訖、固定框寬、框中心沿路徑點移動），取代 10/28 上午做的片段關鍵幀版；數學照搬原專案 `backend/zoom_math.py`（頭尾各 1 秒 ease-in-out、路徑點之間 ease）；V1 上的放大條可拖、可修邊、菱形是路徑點；預覽上的放大框可拖（整段平移／選了點只改那一點）、拖角落等比縮放 |
| D39 | 介面優化（2026-10-28） | 開發者要求：①**區塊可調大小**——預覽｜右側面板、上方｜時間軸、軌道標頭三條分隔線可拖曳（不是收放，D15 不變），尺寸記在這台電腦（localStorage，換專案沿用），雙擊回預設；②**播放中可隨時介入**——任何移動播放頭的操作（拖尺規或把手、軌道空白處按住拖、點逐字稿、方向鍵）都停止播放或倒退、停在新位置；③**右側面板改成大類別＋子頁籤**：Media｜Transcript（逐字稿、字幕樣式）｜Effects（2D、3D、Zoom、Mask、Sound）｜Inspector｜AI Director｜Export（匯出、發佈包），取代 D33 的四組平鋪頁籤；④**漸進式縮圖**——匯入時先做大間隔低解析，空檔再加密、加大，用在拖曳預覽、時間軸影格條、AI 取畫面（§5.13） |
| D40 | 螢幕文字類個資交給 Muse Spark（2026-10-28） | 開發者選定：SAM 3.1 分割不出螢幕上的文字（demo 的金鑰以「API key」「text」都 0 個），帳號、密碼、金鑰、Email、電話、證號等文字類個資改由 **Muse Spark 在每秒 1 格、寬 1280 的畫面上找框**（`/v1/ai/locate`，一次最多 8 張；demo 金鑰 IoU 0.92、每格約 1.2k tokens）；人、臉、車牌等實體物件仍走 SAM。`targetRoute` 依目標決定路線，Mask 頁籤與 AI 導演共用；框依同一列重疊或文字接得上串成物件（打字時框會變長），每個取樣涵蓋到下一格的框（打字中不漏字），離取樣超過 1 秒不遮（§5.3） |
| D41 | 專案資料夾（2026-10-28） | 開發者選定：專案是使用者選位置的資料夾 `<專案名>.wordblade\`，看得到的只有 `project.json`，程式管理的資料放隱藏的 `.data\`；匯出預設放專案資料夾旁邊（同一層），不建子目錄（比字導字演扁平：它的專案下目錄多、匯出要進子目錄拿）；素材用路徑參照（絕對＋相對＋內容指紋，搬家後依序找）；代理檔與縮圖留在程式快取；網頁版用 File System Access 選資料夾並記住素材的檔案權限（`docs/plan-10-28-project.md`） |

**Q1～Q7（開發者 2026-10-26 回覆「照建議」，以下「建議」欄即為決定）**

| # | 問題 | 建議 | 理由 |
| --- | --- | --- | --- |
| Q1 | 剪輯邏輯放哪一邊 | **TypeScript 核心**（時間軸模型、改字即剪、字幕斷句、每格的圖層計算都是純函式），Rust 只負責啟動 ffmpeg／ffprobe、讀寫檔案、背景工作 | 邏輯集中在一種語言、Vitest 測得快；Rust 層薄，Tauri 新手也容易維護 |
| Q2 | 閘道部署在哪 | Zeabur 新開一個 `wordblade` 專案，只放閘道＋PostgreSQL（D23：伺服器只跑 AI 服務）。**已部署（10/27）**：建在作者的 Wonder Mesh 自架主機（開發者稱「神奇網路主機」），公開網址 `https://wordblade-api.zeabur.app`（經東京閘道）；部署腳本 `scripts/gateway-zeabur.ps1`，ID 記在 `gateway/zeabur.json` | 和其他產品的服務、資料庫完全分開 |
| Q3 | 使用者怎麼取得閘道權杖 | **邀請碼**：我產生一批權杖（存 SHA-256），評審與試用者在設定頁貼上即可；不做 Google 登入 | 10 天內做完；評審不必註冊 |
| Q4 | 每人每日額度初值 | **D29 取代：黑客松期間不設上限**，只記錄用量。10/27 實測：AI 導演每格約 130 tokens（Spark，480p、每秒 2 格），30 分鐘素材約 47 萬 input tokens（§5.11） | 以 demo 能順利操作為優先 |
| Q5 | 素材格式 | 影片：每支匯入時都產生 540p 預覽用代理檔（不透明轉 H.264、帶透明轉 VP9 透明 WebM）。WebCodecs 解不了的原檔（ProRes、部分電腦上的 HEVC 等）另由 ffmpeg 轉一份**原解析度的中間檔**（不透明用高位元率 H.264、帶透明用 VP9 透明 WebM），匯出用它；其他情況匯出用原檔。圖片：PNG、JPG、WebP。聲音：WAV、MP3、M4A | 代理檔讓預覽順；中間檔讓 WebCodecs 匯出不必降畫質（D24） |
| Q6 | AI 寫的動畫程式怎麼關起來跑 | **沙盒 iframe＋Web Worker**：`sandbox` 不給 same-origin、CSP 擋掉所有網路，程式只拿得到 OffscreenCanvas 與我們給的繪圖 API；另設執行時間上限；CSP 細項見 §5.7 | 比自己寫 JS 直譯器快很多（10 天內做得完），隔離靠瀏覽器本身；輸出時用同一個 Worker 逐格畫（Q7） |
| Q7 | 特效的輸出方式 | **D24 取代**：預覽與兩版匯出共用同一個 WebGL 合成器；插件畫格以 `ImageBitmap` 從沙盒轉移給合成器，不經 Rust。10/27 實測後定案（D24） | 預覽＝輸出只靠一套程式保證；插件畫格不必來回 Rust 與沙盒 |

## 1. 目標（報名內容）

講師用 OBS 錄課，整理成可上架的影片比錄影本身還花時間：改 ASR 聽錯的技術名詞、剪停頓與重講、對字幕時間、把臉、名牌、API 金鑰等不該出現的東西打馬賽克。WordBlade 是一個剪輯工具（Windows 桌面版＋網頁版，D21），把這些事一次做完：

1. Resolve 風格剪輯：漣漪時間軸、DaVinci Resolve 熱鍵、改逐字稿就剪片。
2. 快速字幕：詞級時間的逐字稿 → 依停頓與標點斷成好讀的字幕行（以英文為主）→ 直接改字 → 匯出 SRT 或燒錄。
3. 隱私遮罩：打字指定要遮的東西 → SAM 3.1 分割並跨格追蹤 → 馬賽克、模糊或純色，每個物件可以單獨開關。
4. AI 校稿：Muse Spark 對照講稿找出疑似聽錯的詞與重複語句，一鍵採用或略過（併進 AI 導演的建議清單，§5.5）。
5. 語音修補：用 Fish Audio 零樣本克隆自己的聲音，重唸講錯的一句（P2，§5.6）。
6. 匯出：MP4（硬體編碼，預覽與匯出用同一個合成器，D24）、SRT。（報名時列的 Final Cut Pro 7 XML 不做，D7。）
7. **素材庫＋多軌時間軸**（D14，報名後追加）：剪輯為主，多支影片、圖片、配樂、音效排在多條軌上；做不出來的效果用外部影片素材補。
8. **AI 導演**（D11，報名後追加）：Muse Wonder 統籌、Muse Spark 1.3 逐段看影片，產出剪輯建議清單，逐條採用。
9. 特效（D8、D17、D19，報名後追加，**核心**）：2D 與 3D（three.js）動畫插件、Vibe特效（用一句話讓 Muse Wonder 寫出插件，3D 插件能和影片互動）、3D 場景（影片貼在桌上的螢幕等 3D 物件上，可以「用說的」控制鏡頭）、轉場。
10. **追加的剪輯功能**（D20）：一鍵去贅詞、發佈包、逐字高亮字幕與重配錄音卡拉 OK 模式、局部放大、片段變速、定格、轉場。

**成功標準**

- 用 WordBlade 從頭到尾剪完一支自己 30～60 分鐘的課：熱鍵剪輯、字幕、遮罩（P1-5，被砍時改用疊加軌的色塊或模糊圖片手動蓋）、輸出 MP4。
- 60 分鐘的課 5 分鐘內產生可剪輯的詞級逐字稿。
- （P1-5）SAM 遮罩在 60 秒片段中跟住目標，不需要手動關鍵幀。
- Demo 影片是 WordBlade 剪自己的宣傳影片（§9）。

## 2. 範圍

| 優先 | 項目 | 完成的定義 |
| --- | --- | --- |
| P0 | 專案與素材庫 | §5.13：建專案、匯入影片／圖片／音樂／音效、代理檔、縮圖與波形；**自動存檔**（每次編輯後 2 秒寫入，寫入用暫存檔＋改名，不會寫壞） |
| P0 | 多軌時間軸＋熱鍵 | §5.13、§5.1：V1 主軌、疊加軌、A 音軌；拖曳、修邊、漣漪剪輯、Resolve 熱鍵、復原／重做；多軌合成預覽 |
| P0 | **動畫插件＋Vibe特效（2D 與 3D）** | §5.7：沙盒執行的 2D（Canvas）與 3D（three.js）插件、內建範本；一句話（可附當格截圖）讓 Muse Wonder 寫新插件（D31），錯誤自動回饋修正；3D 插件可以和影片互動（D19：核心） |
| P0 | **3D 場景＋用說的** | §5.8：three.js 範本「螢幕在桌上」等、鏡頭關鍵幀、背景；一句話讓 Muse Spark 調整鏡頭與場景，先預覽再套用（D19） |
| P0 | MP4 匯出 | §5.4：WebGL 合成器（與預覽共用）逐格算、WebCodecs 硬體編碼、音訊離線混音、燒錄字幕 |
| P0 | Muse ASR 字幕＋改字即剪 | §5.2：切段、詞級時間重建、英文為主的斷句、直接改字、SRT；逐字稿刪字即剪 |
| P0 | 閘道 | §6：AI 任務路由、轉送路由、邀請權杖、用量紀錄（不設上限，D29） |
| P0 | 網頁版 | §5.21：同一套介面在 Chrome／Edge 執行；讀寫用 File System Access＋OPFS；匯出和 Windows 版共用合成器（D24）；部署成靜態網站 |
| P0 | 範例專案 | §5.22：一鍵開啟、預先算好的 2 分鐘範例；網頁版首頁就有按鈕 |
| P1-1 | **AI 導演** | §5.11：看整支錄影 → 建議清單（剪掉重講、遮隱私、加特效、加運鏡、局部放大、改字）→ 逐條採用 |
| P1-2 | 局部放大 | §5.19：片段的縮放與平移關鍵幀（可沿路徑移動）；AI 導演可以提議 |
| P1-3 | 逐字高亮字幕 | §5.18：卡拉 OK 式逐字變色／放大，用重建的詞級時間 |
| P1-4 | 一鍵去贅詞 | §5.16：um、uh、呃等一鍵剪掉，可逐一檢查 |
| P1-5 | SAM 3.1 遮罩＋遮罩轉名詞片語 | §5.3：打字指定目標（任何語言 → 英文名詞片語）、追蹤、三種效果、逐一開關 |
| P1-6 | 片段變速 | §5.20：0.25～4 倍速，聲音保持音高（demo 的「加速播放製作過程」要用） |
| P1-7 | 發佈包 | §5.17：Muse Spark 寫標題、說明、章節、標籤；Muse Image 做縮圖 |
| P1-8 | AI 音效 | §5.15：一句話 → 宣告式音效（JSON）→ WAV → A3 音效軌 |
| P1-9 | 重配錄音卡拉 OK 模式 | §5.18：選一段字 → 提詞器照原本的時間逐字高亮 → 跟著念、用麥克風錄 → 換掉原本那段人聲 |
| P1-10 | 聲音分離 | §5.14：人聲／背景音樂兩個獨立片段（本機 MDX-Net ONNX，只跑人聲模型；只有 Windows 版，D28） |
| P1-11 | AI 音樂（WebAudio） | §5.15：一句描述＋長度 → 宣告式配樂（JSON，可循環）→ WAV → A2 配樂軌 |
| P1-12 | 一鍵片頭 | §5.23：多張封面＋標題 → 選風格 → 一鍵產生片頭（畫面、翻頁／轉場音效、配樂對拍），可改參數重算、一次 Ctrl+Z 復原 |
| P1-13 | 清除無聲片段 | §5.16b：依對白音量包絡找出超過 N 秒的無聲段 → 確認清單 → 一次剪掉（漣漪），一次 Ctrl+Z 復原 |
| P1-14 | Muse Image 材質圖與 3D 背景 | §5.12：一句話 → 無縫材質（顏色＋本機算的法線貼圖）→ 材質庫 → 套到 3D 場景表面、3D／2D 插件；同一條路也產生 3D 背景圖 |
| P2 | AI 重生語音 | §5.6：Fish Audio，樣本取分離後的人聲 |
| P2 | 定格 | §5.20：在播放頭凍結畫面一段時間（11/2 已做） |
| P2 | 轉場 | §5.9：溶接、穿黑／白、推移、推近（11/2 已做，推近不做） |
| P2 | AI 音樂（MusicGen） | §5.15：Meta MusicGen（權重非商用，只限黑客松） |
| P3 | 色彩調整 | 亮度、對比、飽和度、色溫（11/2 已做：改成時間軸範圍，預設整條） |

**順序與取捨**

- P0 一定要做完，其中 Vibe特效（2D＋3D）與 3D 場景是核心（D19），排在剪輯骨架之後最先做。
- P1 依編號順序做。**11/1 檢查點**：落後時從 P1 的最後一項往前砍（AI 音樂 → 聲音分離 → 重配錄音 → AI 音效 → 發佈包 → 變速（demo 改用跳剪）→ SAM → …），P0 不砍。
- P2、P3 只在 P1 做完後才做。

**不做**：FCP7 XML 匯出、簡轉繁、多國語系（只做英文介面）、帳號系統、macOS 桌面版（Mac 用網頁版）。

## 3. 架構

```
┌──────────────────── WordBlade 桌面（Tauri 2） ────────────────────┐
│ React 19 + TS 介面（單一畫面）──► TS 核心（純函式，Vitest）             │
│   素材庫／預覽／屬性／逐字稿＋導演清單／多軌時間軸                         │
│   時間軸模型、改字即剪、字幕斷句、詞級時間重建、每格圖層計算                │
│ WebGL 合成器（預覽與匯出共用，D24）＋WebCodecs 編碼＋mediabunny 封裝       │
│   音訊：Web Audio 預覽／OfflineAudioContext 匯出；宣告式音效與配樂解讀      │
│ 沙盒 iframe（無 same-origin、CSP 擋網路）                               │
│   Worker：2D Canvas／three.js 插件逐格畫 ──ImageBitmap──► 合成器          │
│        │ invoke                                                       │
│ Rust 指令層：ffmpeg／ffprobe sidecar（代理檔、中間檔、抽 ASR 音訊）、       │
│   檔案、背景工作、聲音分離（ort＋rustfft，MDX-Net ONNX，DirectML／CPU）     │
└────────┼──────────────────────────────────────────────────────────┘
         │ HTTPS（邀請權杖）
┌────────▼──────── WordBlade 閘道（Spring Boot 4.1＋Spring AI 2.0，Zeabur）──────┐
│ AI 任務（ChatClient＋結構化輸出＋Media＋ChatMemory＋@Tool）                     │
│   /v1/ai/director ──► Muse Wonder 統籌＋Muse Spark 1.3 逐段看影片            │
│   /v1/ai/vibe ──► Muse Wonder（D31；退路 Muse Spark 1.3）                    │
│   /v1/ai/proofread、plane3d、mask-terms、sound、music ──► Muse Spark 1.3    │
│   /v1/ai/publish ──► Muse Spark 1.3                                         │
│   /v1/ai/image ──► Muse Image                                              │
│ 轉送（RestClient）：/v1/asr ──► Muse Voice Transcribe                       │
│   /v1/sam ──► SAM 3.1（上傳、SSE、刪檔）  /v1/tts ──► Fish Audio               │
│   /v1/music ──► MusicGen（Modal／Baseten，P2）                              │
│ 權杖驗證、用量紀錄（PostgreSQL；不設上限，D29）                                 │
└────────────────────────────────────────────────────────────────────┘
```

- **提示詞在閘道**：桌面只送任務資料（逐字稿、描述、截圖、目前設定），拿回驗證過的結構化結果。提示詞與護欄要調整不必發新版桌面程式，也不會隨安裝檔流出。

- **兩個外殼、同一套程式（D21）**：介面、TS 核心、合成器、沙盒都只寫一份；和平台有關的部分（讀寫檔、轉代理檔與中間檔、抽 ASR 音訊、聲音分離、錄音）收在 `Engine` 介面後面，有 `DesktopEngine`（Tauri＋Rust）與 `WebEngine`（瀏覽器 API）兩個實作。匯出（合成＋編碼）兩版共用，只有最後寫檔走 `Engine`。
- **本機為主**：完整影片、剪輯與輸出都在本機。會送到閘道（再轉給 Meta 或 Fish Audio）的資料只有下面這些，第一次用到每一類時顯示同意對話框，說明送什麼、送到哪；送給 Muse Spark 的要註明 Contributor 版的內容可能被 Meta 用於訓練（D32）：
  - Muse ASR：16 kHz 單聲道音訊（§5.2）。
  - SAM：縮小、無聲的影片片段（§5.3）。
  - AI 導演：480p、每秒 2 格、無聲的影片分段＋逐字稿（§5.11）。
  - Vibe特效、3D 用說的：描述、當格截圖、參考圖（§5.7、§5.8）。
  - Muse Image：材質描述（無縫材質）、背景描述，或縮圖的底圖＋標題（§5.12）。
  - 校稿、發佈包：逐字稿（§5.5、§5.17）。
  - AI 重生語音：前後的人聲樣本與要唸的字（§5.6）。
- **專案檔** `<專案名>.wordblade.json`：素材庫、各軌片段、每支素材的逐字稿、字幕斷點 override、特效；遮罩的逐格資料放旁檔 `masks/<id>.bin`，JSON 只存參照；素材只存路徑（Windows 版）或 `FileSystemHandle`（網頁版，存在 IndexedDB，重開專案時請使用者重新授權）；代理檔放 `proxies/`、中間檔放 `mezzanine/`；復原歷史不存。
- **ffmpeg** 以 Tauri sidecar 打包，只做代理檔、中間檔、抽 ASR 音訊（D24）。**打包 LGPL 版**（BtbN 的 `lgpl` 建置，不含 libx264）：代理檔與中間檔依序**實際試編 1 格**（只看編碼器清單不準：原專案 2026-09-17 在 Arc 機器上 `nvenc` 有列出卻載入失敗）`h264_qsv`（Intel 內顯）、`h264_nvenc`、`h264_amf`，都不行就用 `h264_mf`（Windows 內建的 Media Foundation 編碼器，每台 Windows 10／11 都有，LGPL 版也能用）。不需要 libx264 或 OpenH264。10/27 實測（`spikes/ffmpeg-encoders/`，Core Ultra 5 125H＋Arc 內顯）：`h264_qsv`、`h264_mf` 可用。開發機上的 gyan 版是 GPL 建置，只在本機開發用，不打包。10/27 定版：BtbN `autobuild-2026-10-26-14-25` 的 `ffmpeg-n9.0.2-…-win64-lgpl-shared-9.0.zip`（shared 版：exe＋DLL，比 static 小一半），只留 `ffmpeg.exe`、`ffprobe.exe`、DLL 與授權（約 150 MB 未壓縮），由 `scripts/fetch-ffmpeg.ps1` 下載到 `src-tauri/resources/ffmpeg/`（不進版控），打包時放 `$RESOURCE/ffmpeg/`；腳本會擋 GPL 建置並實測編碼器（qsv、mf、aac 可用）。執行時先找打包的，找不到才用 PATH 上的（開發機）。
- **打包（原專案實測）**：大型二進位（ffmpeg、onnxruntime 等）放 Tauri `resources` 的資料夾形式，不要 onefile 的 `externalBin`（原專案引擎啟動從 13 秒降到 0.3 秒）；新增 IPC 指令要同時改 `build.rs`、`generate_handler!`、permission 三處；sidecar 不要拿 stdout 當協定通道（原專案曾因 log 寫 stdout 讓 IPC 斷線）；程式還開著時 `tauri build` 會因檔案被鎖失敗。安裝檔約 70～110 MB、打包 12～18 分鐘。
- **repo 授權**：提交前公開時選定（建議 Apache-2.0）；README 列出第三方授權（ffmpeg、three.js MIT、字型 Inter 與 Noto Sans TC（OFL，字幕用，D37）、MDX-Net 模型（Kim_Vocal_2 上游授權不明，見 §5.14）、python-audio-separator MIT、onnxruntime-directml 隨附的 `DirectML.dll`（Microsoft 專有授權，限 Windows）、acorn（MIT，2D 插件直譯器用，`src/anim/vendor/`）、原專案字導字演的動畫直譯器與元件庫（Apache-2.0，作者本人）、mediabunny、soundtouchjs LGPL、MusicGen CC-BY-NC、**SAM 遮罩解碼器**（`src/sam/decoder.ts`，改寫自 Meta `meta_sam_parser` 0.0.6，SAM License，散布時附 `licenses/meta-sam-parser-LICENSE.txt` 全文；開發者 2026-10-28 同意））。

## 4. 資料模型（TS 核心）

| 型別 | 欄位 | 說明 |
| --- | --- | --- |
| `Media` | id、path（Windows 版）或 handleKey（網頁版，指向 IndexedDB 裡的 `FileSystemHandle`）、kind（video／image／audio）、duration、fps、width、height、hasAlpha、audio、proxyPath?、mezzaninePath? | 素材庫的一筆；ffprobe（網頁版用 mediabunny）讀出 |
| `Track` | id、kind（video／audio）、role（音軌才有：dialogue／music／sfx）、index、muted、locked、volume | V1 是主軌（片段首尾相接、漣漪剪輯）；V2 以上與 A 軌可以有空隙。配樂壓低看 role（music 被 dialogue 壓）；聲音分離新增的軌是 music |
| `Clip` | id、mediaId、trackId、srcIn、srcOut、start（時間軸秒）、speed、opacity、transform（全畫面或子母畫面的框）、fadeIn、fadeOut、volume、freeze? | 時間軸上的一段；剪輯就是切開、刪除、移動片段。`freeze`（定格，§5.20）記凍結的素材時間與長度 |
| `Word` | id、mediaId、text、start、end | 素材時間；每支素材自己的逐字稿 |
| `CaptionBreak` | wordId、kind（breakAfter／joinAfter／lineBreakAfter） | 使用者調過的斷點，以詞的 id 為鍵；斷句規則算出的斷點遇到 override 就照 override |
| `MaskObject` | id、mediaId、prompt、label、framesRef（指向 `masks/<id>.bin`：每格的框與遮罩，SAM 回的格式見 §5.3）、effect、enabled | 素材時間；遮罩跟著素材走，片段移到哪裡都套得上 |
| `Effect` | id、kind（anim2d／anim3d／scene3d）、start、end、pluginId、params、cameraKeys?、anchors | 時間軸時間；2D／3D 插件與 3D 場景（§5.7、§5.8、§5.10 的順序）；`cameraKeys` 的時間相對於區段開頭 |
| `ZoomRegion` | id、mediaId、start、end（素材秒）、w（框寬 0.25～1，倍率 1/w）、path（路徑點：素材秒、cx、cy）、enabled | 局部放大的一段（§5.19、D38），存在 `Project.zooms`；用素材時間記，剪輯後跟著素材走 |
| `Plugin` | id、kind（2d／3d）、code、paramSchema、soundIds?、source（builtin／vibe）、hash | 插件與 AI 生成的程式；存在專案裡，載入時重新跑沙盒驗證。2D 插件要音效時引用 `Synth` 的 id，不自己發聲 |
| `Synth` | id、kind（sound／music）、spec（宣告式 JSON）、source（builtin／ai）、renderedMediaId? | AI 音效與配樂（D27）；`spec` 由我們的程式解讀成 WAV，再變成素材 |
| `Anchor` | id、mediaId? 或時間軸時間、x、y（0～1）、label、from（user／sam／director） | 定位點：插件、鏡頭跟著它（§5.7 的 `env`） |
| `Suggestion` | id、mediaId、kind（cut／mask／effect／camera／fix）、start、end、payload、reason、status（pending／applied／skipped） | AI 導演的建議；素材時間，採用時換算到用到這支素材的片段 |
| `Stem` | 原素材 id → 人聲／背景兩個衍生素材 id、模型 | 聲音分離的結果也是素材，記住從哪來（§5.14） |

字幕（D26）：不另存字幕文字。字幕＝`f(V1／A1 上片段的 Words, 斷句規則, CaptionBreak)`，換算到時間軸時間，每次需要時重算。

- 手改字幕的文字就是改那幾個 `Word.text`；改完詞數變了（例如把一個詞改成兩個），就把改後的文字重新分詞，在原本那幾個詞的總時間內按字元數比例分配（同 §5.2 步驟 3），舊詞換成新詞。
- 手動拖斷點、合併兩段、強制換行，存成 `CaptionBreak`；之後重算也不會蓋掉。

改字即剪：在某段的逐字稿刪字 → 把那個片段在對應的素材時間切開並刪掉中間，再照下面的漣漪規則補位。

**V1 漣漪刪除的跨軌規則（D25，比照 Resolve）**：刪掉時間軸上的 `[a, b)`、長度 `d = b − a` 時：

1. 鎖定的軌完全不動。
2. 未鎖定的軌：
   - 整段在 `b` 之後的片段左移 `d`。
   - 跨在 `[a, b)` 上的片段：同一支素材的 A 片段一起剪掉那段（影音才不會錯開）；其他片段（疊加、配樂、音效）也剪掉落在 `[a, b)` 內的部分，後半段左移。想讓配樂保持連續，就先鎖定配樂軌。
3. `Effect` 與時間軸時間的 `Anchor`：整段在 `b` 之後的左移 `d`；整段落在 `[a, b)` 內的刪除；跨在上面的，長度減掉重疊的部分，`cameraKeys` 依比例壓縮。
4. 用素材時間記的資料（`Word`、`MaskObject`、`Suggestion`、`ZoomRegion`）不用動，它們跟著片段走。

所有編輯都是「舊狀態 → 新狀態」的純函式，復原堆疊存狀態快照；狀態用結構共享（Immer），沒改到的部分（例如遮罩資料）在快照之間共用，不會每次編輯都複製一份。

## 5. 功能細節

### 5.1 剪輯與熱鍵

- 熱鍵照 DaVinci Resolve 預設鍵盤設定（開工時對照 Resolve 20 的鍵盤設定逐一核對）：J／K／L 倒退／停／前進（連按加速）、I／O 設入出點、Ctrl+B 在播放頭切割、漣漪刪除、← → 逐格、↑ ↓ 跳到上／下一個剪輯點、Ctrl+Z／Ctrl+Shift+Z 復原與重做、Space 播放。J 倒放不能用負的 `playbackRate`（瀏覽器不支援），用 rAF 每格回退 `currentTime`（無聲）；L 連按 2／4／8 倍用 `playbackRate`。時間換成格數一律 `Math.round`（`currentTime` 只到微秒，`floor` 會卡格，原專案 2026-09-16）。
- 漣漪時間軸：V1 刪掉的段落不留空隙，其他軌照 §4 的跨軌規則一起移動（鎖定軌不動）；V2 以上與音軌可以自由擺放；拖曳片段、修邊、吸附到播放頭與片段邊界；時間軸上可以看到剪輯點，點了跳過去。
- 改字即剪：在逐字稿點選或拖選詞，按 Delete 就在對應片段的素材時間切開、刪掉中間（頭尾吸附到詞的邊界，前後各留 0.05 秒；V1 漣漪補位，其他軌照 §4 的跨軌規則）。
- **時間軸範圍選取（D38，照字導字演）**：Shift＋按住軌道拖曳，以播放頭為錨點拉出範圍（I 設入點、O 設出點）；範圍上方的動作列：🔍 Zoom（建立局部放大）、✨ Effect（切到 Vibe 頁籤，範本與 AI 特效蓋住整段範圍）、✂ Delete（漣漪刪除，同 Delete 鍵）、✕（同 Esc）。
- 預覽：見 §5.13 的多軌合成預覽。

### 5.2 Muse ASR 字幕

已實測的事實（2026-10-14，三支中文錄課影片）：端點 `https://api.meta.ai/v1/asr/transcribe`；只收 WAV mono 16-bit 16／24 kHz、≤ 32 MB、≤ 10 分鐘；`PUSH_TO_TALK` 不回時間，`DIARIZATION` 才有 turn 級 `startMs／endMs`；有 `keywords` 偏向術語；554 秒影片約 89 秒；轉出的稿子與參考稿的接近程度不輸 Groq Whisper turbo。注意（原專案 2026-09-16）：128 秒的短片 turns 只涵蓋 41.9 秒（原因不明），10/31 要檢查有沒有漏段；`languageBias` 填繁體仍輸出簡體。英文影片還沒實測，10/31 用 D30 錄的範例短片跑。

流程：

1. 抽 16 kHz mono WAV（Windows 版 ffmpeg、網頁版 mediabunny）；在靜音處切成 ≤ 60 秒的段（原訂 9 分鐘，10/27 實測後改，原因見下方「每段 60 秒」）。
2. 每段帶 `keywords`（講稿抽出的術語）經閘道送出，最多 3 段平行。
3. 詞級時間重建（Muse 沒有詞級時間，官方文件明列不提供；10/27 改用 DELTA 錨點）：
   - **DELTA 錨點（主要做法）**：閘道向 Meta 送 `partialMode: DELTA`＋`Accept: text/event-stream`，把串流整理成 JSON 回傳——`deltas`（每個文字事件的一兩個字＋`audioProcessedMs`）與 `turns`（speechStart／speechEnd／speechComplete＋說話者）。10/27 實測：文字事件約每 0.32 秒一個、每個約 1.2 字，事件時間比字的結尾晚約 0.35 秒。
   - 每個事件的字佔「前一個事件時間 − 延遲」到「這個事件時間 − 延遲」（每個字最多 0.5 秒，停頓不算進字長），同一事件的幾個字依字數比例分（英文以空白分詞、標點黏前一個詞；中文逐字）。
   - 再用音量包絡（RMS 門檻＋最短靜音 0.25 秒）細調：起點落在無聲處就往後吸附到下一個開口（1.5 秒內）；離開口 0.3 秒內、前一個字在停頓之前就吸附到開口；起點嚴格遞增，結尾是下一個字的起點或有聲段的結尾。
   - **退路**：閘道沒有回 `deltas`（舊版）時，依包絡把每個 turn 的字依字數比例攤到有聲段上（動態規劃分配）。這個做法的誤差隨 turn 長度變大，真人連續講話時 Muse 一個 turn 可長達 3 分鐘，不夠準。
   - 精度還不夠的話，升級路徑是 Meta 開放權重的 MMS forced aligner（P2 以後）。
4. 不做簡轉繁：ASR 回什麼文字就用什麼（D7）。
5. 字幕斷句（以英文為主）：
   - 先斷句：句末標點（`.` `?` `!`）或停頓 ≥ 0.5 秒。
   - 一句太長再斷行：每行最多 42 個字元、最多 2 行；優先斷在逗號、分號、冒號之後，其次斷在連接詞（and、but、so、because…）與介系詞之前；不讓冠詞、介系詞留在行尾，不拆開數字與單位。
   - 每段字幕最短 1 秒、最長 7 秒；閱讀速度上限每秒 17 個字元，超過就延長顯示或拆段。
   - 中文內容照樣能轉錄與上字幕，用同一套規則（行長改以全形字計），不另外調。
6. 驗收：用自己的英文錄影（至少 2 支）量「詞的起點和人工標的起點」平均誤差，目標 ≤ 0.15 秒；字幕抽 50 段人工看，斷在不自然位置的 ≤ 10%。

**實作狀態（2026-10-27 提前完成）**

- 閘道 `POST /v1/asr`（`gateway/.../asr/`）：multipart 的 audio（WAV）＋選填 keywords；先檢查 WAV（PCM 單聲道 16-bit、16／24 kHz、≤ 600 秒），不合格回 400 不送上游；轉送 Meta `/v1/asr/transcribe`（DIARIZATION），只回 transcript、turns、audioDurationMs；用量記音訊秒數；上游 429 回 503（桌面重試）、其他錯誤回 502，上游訊息只寫閘道 log。multipart 上限 33 MB（Spring 預設只有 1 MB）。
- **multipart 要自己組**（10/27 實測）：Spring 的 `FormHttpMessageConverter` 會在每個 part 加 `Content-Length` 標頭，Meta 對這種寫法回 400「Malformed multipart body」，拿掉就 200（瀏覽器的 FormData 也不帶）。
- 桌面（`src/asr/`）：`splitAtSilence` 依音量包絡在無聲處切成 ≤ 180 秒的段（比 §5.2 原訂的 9 分鐘短：每段十幾秒就回來、3 段平行更快，也避開代理逾時）；`Engine.extractAsrAudio` 抽 16 kHz 單聲道 WAV（Windows 版 Rust `asr_pcm` 用 ffmpeg 出 s16le 再補檔頭，網頁版 mediabunny 解碼＋盒狀濾波降取樣）；`transcribeMedia` 最多 3 段平行、503 重試；`turnsToWords` 依包絡重建詞級時間（標點黏前一個詞、中日文逐字、跨過停頓的詞界吸附到停頓兩側）；`coverage` 算 turns 涵蓋多少有聲時間，低於 90% 在介面提醒可能漏段。結果用 `setWords` 寫進專案（一筆可復原的編輯，指到舊詞的字幕斷點一起刪掉）。
- 介面：逐字稿頁籤上方每支有聲素材一顆 Transcribe（第一次問上傳同意；素材還在算音量包絡時停用）。完整的逐字稿面板 11/1 做。
- 實測（`pwsh scripts/asr/live-local.ps1`：本機閘道＋臨時資料庫＋一次性權杖，跑 `e2e/asr-live.spec.ts`）：`samples/lecture-a.en.mp4`（282 秒英文 TTS）切 2 段、26.4 秒轉完、559 詞、沒有漏段提醒；字幕句子起點對 SRT 的誤差（20 句對上 13 句）平均 0.109 秒、中位數 0.062、p90 0.133。這是 TTS、句級的近似；§5.2 的詞級 ≤ 0.15 秒驗收等 D30 的真人錄影。閒置的 1 秒靜音 Muse 會幻聽出「Yeah」。
- **每段 60 秒**（10/27 實測後由 180 秒改）：詞級時間的誤差主要跟 Muse 一個 turn 多長有關——每段 180 秒時 Muse 回了一個 85 秒、幾乎沒有標點的 turn，句首一致提早 1.5～2.3 秒（依字數比例攤時間，縮寫字如 OpenAI、dotenv 唸得比字數長，被吞掉的 uh 也讓後面整批往前；改成動態規劃分配也救不回來，因為只有 turn 的頭尾是錨點）；60 秒時 turn 最長約 21 秒，模擬短片 25 句第一個詞的起點平均誤差 0.19 秒、中位數 0.06、19 句在 0.3 秒內；30 秒切點太多反而 0.36 秒。lecture-a 改 60 秒後 15.4 秒轉完（原 26.4 秒）、句子起點平均誤差 0.057 秒。詞分配改成動態規劃（每個有聲段分到一串連續的詞，讓段長與詞數推估的長度最吻合）。回歸測試：`src/asr/demoAlignment.test.ts`（真實 Muse 回應＋真實音量包絡＋正確答案）。
- **DELTA 錨點實測**（10/27，`docs/plan-10-31.md` ④）：句首起點對正確答案的平均誤差——模擬短片 0.066 秒（包絡推算 0.18）、lecture-a 0.038 秒（0.057）；回歸測試（真實 DELTA 事件＋真實包絡＋正確答案）25 句平均 0.067 秒、中位數 0.01、24 句在 0.15 秒內。改用 DELTA 後段長不再影響準度，仍維持每段 60 秒是為了 3 段平行與回應時間。FOSDEM 真人片段 519 詞（沒有正確答案）。模式比較（`scripts/asr/probe-modes.mjs`）：真人連續講話時 DIARIZATION 回一個 179 秒的 turn、ENDPOINTING 最長 104 秒，都沒有標點。
- **模擬 D30 短片**（`node scripts/demo-sample/make.mjs`，108 秒英文 TTS＋仿 VS Code 螢幕錄影，附 `demo-2min.truth.json`）的 Muse 實測：**uh 全被吞掉（0/3）**、um 留 2～3/4、you know 2/2——§5.16 一鍵去贅詞**一定要**做「有聲音卻沒有對應文字的短片段」的聲音退路，不能只靠 ASR 文字；講錯重講的句子有轉出來。Muse 會**疊字**（takes takes、on on、a a、is is、line line、next next，TTS 沒有疊），不要自動合併（真人的「with, with the wrong」是真的），留給改字即剪與 AI 導演處理；長 turn 幾乎沒有標點，字幕斷句靠停頓；`dotenv` 被聽成 Daemdov／Dondov，是 keywords 的實際用途。
- **真人英文實測**（10/27，FOSDEM 2025〈Lessons learned open-sourcing the UK's COVID tracing app〉第 5～8 分鐘，CC BY 2.0 BE，只在本機測試、不散布，出處記在 `samples/fosdem-covid-3min.ATTRIBUTION.txt`）：180 秒切 4 段、22.5 秒轉完、512 詞、沒有漏段提醒；**真人的語助詞有保留**（um 9、uh 2、you know 2），和 TTS 模擬片 uh 全被吞不同——模擬片的 uh 可能是 TTS 根本沒唸出來，§5.16 仍保留聲音退路當保險；相鄰重複詞 14 處（真人會重複，和 Muse 疊字分不開）；每段 60 秒時最長的 turn 仍有 42.7 秒。沒有正確答案，詞級誤差沒量。
- 還沒做：keywords 從講稿抽術語（介面還沒有講稿輸入）、真人錄音的逐字驗收（等 D30 真人錄影，人工標起點；或用 Fish TTS 的 with-timestamp 端點產生逐字正確答案）。

### 5.3 SAM 3.1 遮罩（P1-5）

1. 使用者輸入要遮的東西（例如「我的臉和桌上的名牌」）。P1 由 Muse Spark 轉成英文名詞片語（`face`、`name badge`）；P0 先讓使用者直接打英文。
2. 選範圍後，Rust 層用 ffmpeg 剪出縮小、無聲的片段（寬 ≤ 1280、每秒 10 格），上傳前顯示同意對話框。
3. 閘道上傳到 Meta Files API（一定要設 `expires_after[seconds]=3600`，不設會永久保留）、呼叫 SAM 3.1 影片追蹤、把逐格結果以 SSE 轉回、結束後刪檔。原專案實測（2026-10-06，`transcript-review/backend/face_track.py`）：每格一個 delta；遮罩內容是 base85 編碼（不是 RLE），解碼方式做 SAM 時再確認；刪一個檔要 4～5 秒，且 `GET /v1/files/{id}` 會在 404 與 200 之間跳，不能拿來判斷刪了沒；取消時要記下 socket 主動關（Windows 的 `shutdown` 不會讓卡住的 `recv` 返回）。
4. 換鏡頭處切段（ffmpeg `scdet`），同一個物件不跨鏡頭配對，取樣之間也不借相鄰鏡頭的遮罩。原專案 2026-10-07 實測：沒切段時 SAM 把舊鏡頭的 id 接到新鏡頭，出現蓋住 56% 畫面的怪物件、新鏡頭的車牌只遮到 0～1%。
5. 物件清單：每個物件一列，可開關、選效果（馬賽克、模糊、純色）與強度。
6. 預覽與輸出：遮罩屬於素材（素材時間），哪一軌放了這支素材的片段，合成器就在那個片段疊進合成之前，把那格的 RLE 解成遮罩貼圖、用 shader 套效果（D24）；預覽與輸出是同一段程式。
7. 費用：SAM 影片 US$0.20／千格（原專案也只列為待確認，沒有帳單紀錄；做 SAM 時用一次實際呼叫確認）；每秒 10 格時 1 分鐘約 US$0.12（不設上限，D29；用量照樣記錄）。
9. **文字類個資（D40）**：SAM 分割不出螢幕文字，帳號、密碼、金鑰、Email、電話、證號交給 Muse Spark 每秒 1 格找框（`src/sam/locate.ts`、閘道 `/v1/ai/locate`）；Mask 頁籤的常用目標分兩類，自訂目標翻譯後由 `targetRoute` 分流。
8. **實作（2026-10-28，`docs/plan-10-28-sam.md`）**：閘道改成輪詢工作（`POST /v1/sam` multipart → 背景上傳、讀串流、逐格切行；`GET /v1/sam/{id}?after=N`；`DELETE` 取消，0.5 秒內停）而不是轉 SSE（Wonder Mesh 撐不住長請求）；目標翻譯 `POST /v1/ai/mask-phrase`（Muse Spark，已是英文名詞片語就不呼叫）。小檔改在 WebView／瀏覽器用 mediabunny 轉（和匯出同一條讀檔路，桌面與網頁共用），每段 ≤ 90 秒、相鄰重疊一格、用 IoU ≥ 0.3 接續；換鏡頭用 64 寬小畫面的像素差（原專案 CutScan），不用 ffmpeg scdet。遮罩存在專案（每個取樣存 SAM 的編碼字串，用到才解碼），合成器 `drawMasked` 預覽與匯出共用。解碼器改寫自 Meta `meta_sam_parser`（SAM License，附全文）。實測：計費格數＝送出格數，但每次至少 50 格；FOSDEM 6 秒 60 格從按下到完成 13.9 秒。已知限制：每次請求最多 16 個物件（只提示）、取樣之間形狀不動、遮罩物件不能手動修。

### 5.4 MP4 匯出（D24：和預覽共用合成器）

**合成器**（TS＋WebGL2，預覽與兩版匯出共用一份）

- 每一格由 TS 核心算出「這格要畫哪些圖層、各自的素材時間與變換」（純函式，Vitest 測），合成器照 §5.10 的順序畫：片段畫面（含變速的時間映射、局部放大、遮罩、淡入淡出、透明度、子母畫面的框）→ 3D 場景 → 疊加軌 → 2D／3D 插件 → 字幕。
- 畫面來源是唯一的差別：預覽用 `<video>`／`<img>` 當貼圖（§5.13），匯出用 WebCodecs `VideoDecoder` 解原檔或中間檔（Q5）逐格餵進來。
- 2D／3D 插件與 3D 場景：合成器把需要的當格畫面以 `ImageBitmap` 送進沙盒，插件畫完以 `ImageBitmap` 轉移回來（postMessage 的 transferable，不複製、不經 Rust；§5.7）。
- 字幕（D37）：`captionLayout`（純函式：置中、太寬整體縮小、逐字高亮狀態）＋`CaptionLayer`（Canvas 2D 畫在透明的 OffscreenCanvas，合成器疊在最上層）；預覽與匯出同一個類別，畫出來一致。字型 Inter＋Noto Sans TC 隨程式打包；Canvas 不會自己觸發字型分塊下載，預覽先用備用字型、載好再重畫，匯出開始前全部載好。樣式存在 `Project.captionStyle`（字幕樣式頁籤，`setCaptionStyle` 編輯）。

**編碼與封裝**

- 影像：WebCodecs `VideoEncoder`，H.264，`hardwareAcceleration: "prefer-hardware"`（Windows 上 WebView2／Chrome 走 Media Foundation，Intel 內顯可以用 QSV 硬體編碼），沒有硬體就用軟體編碼。
- 聲音：`OfflineAudioContext` 離線混音——各片段依時間排好、音量與淡入淡出、配樂壓低（看 dialogue 軌人聲的音量包絡算出增益曲線，預覽用同一條曲線）；變速保持音高用 WSOLA 時間伸縮（預覽另走 `preservesPitch`，§5.13；10/31 實測兩邊聽起來差多少）。混好後 `AudioEncoder` 編 AAC，沒有 AAC 編碼器就用 Opus。WSOLA 先用現成的 soundtouchjs（LGPL，列進 §3 的第三方授權），不合用再自己寫。
- **分段處理，不整支放進記憶體**：60 分鐘的成片光輸出的音訊緩衝區就約 1.4 GB（48 kHz 立體聲 float32）。所以聲音每 5 分鐘一段用一個 `OfflineAudioContext` 算（只解碼那一段用到的來源音訊），依序餵給編碼器；影像也是解一格、畫一格、編一格。
- 封裝：mediabunny 用串流方式寫 MP4（邊編碼邊寫出，不在記憶體累積）；寫檔走 `Engine`（Windows 版用 Tauri 的檔案 API 分塊寫，網頁版用 File System Access 的可寫串流）。
- 進度：已編碼的格數／總格數；可取消。
- 同時輸出 SRT（剪後時間）。

**實作狀態（2026-10-27 提前完成）**

- `src/export/`：`exportPlan`（大小、格率、位元率、每個片段要解的格）、`exporter`（每個片段一條 `VideoSampleSink` 串流並預先解下一格 → `layerPlan`＋`GlCompositor` 畫在 OffscreenCanvas → 特效向沙盒逐格 await → `CanvasSource` 編碼）、`audioMix`、`srt`；匯出頁籤 `src/ui/ExportTab.tsx`（依素材／1080p／720p、進度、取消，插件出錯只略過該特效並在完成訊息列出）。
- 聲音：不用 `OfflineAudioContext`，改成 TS 直接混（每 5 分鐘一段、增益與壓低曲線逐樣本算，純函式可測）；來源用 `AudioSampleSink` 只讀那一段，線性內插換成 48 kHz，變速片段用 soundtouchjs 的 WSOLA。
- 編碼器先用 `VideoEncoder.isConfigSupported` 問硬體，沒有就改軟體（無頭 Chromium 沒有 H.264 硬體編碼器，指定 prefer-hardware 會直接失敗）。
- 寫檔：`Engine.openExportTarget`——Windows 版存檔對話框＋Rust `export_open／export_write（raw body，位置放標頭）／export_close／export_abort`；網頁版 `showSaveFilePicker` 的可寫串流，沒有對話框（或 e2e 設 `wordblade.exportToOpfs`）時寫進 OPFS。SRT：Windows 版寫在 MP4 旁邊，網頁版以下載給出。
- 實測：e2e（`e2e/export.spec.ts`）3 項——影片＋聲音＋2D 特效（長度、解析度、48 kHz 聲音、紅框畫進去、特效後和原片同一格）、取消（不留半成品）、3D 場景（中段有木紋桌、開頭滿版）；WebView2 自我檢查（`src/selftest.ts` 的 `checkExport`）：asset 協定讀原檔、Rust 分塊寫檔都正常，1080p 30 秒片段 6.1 秒（4.9 倍即時，單一串流、無特效）。
- 字幕燒進畫面、局部放大 10/28 已做（D37、§5.19）。還沒做：遮罩；變速片段預覽（`preservesPitch`）和匯出（WSOLA）聽起來差多少，等 P1-6 有變速介面時一起聽。

**不採用的路線：ffmpeg 濾鏡圖匯出（10/27 實測後放棄，D24）**

- 量測（`spikes/export-bench/RESULT.md`，11.3 分鐘 1080p 多軌片）：沒有 3D 時 ffmpeg `h264_qsv` 136.5 秒、統一合成器（WebView2）232.3 秒；加一段 60 秒 3D 後，統一合成器 254.9 秒，ffmpeg 路線估算 536～676 秒。ffmpeg 路線的 3D 畫格要經 Tauri IPC 在 WebView 與 ffmpeg 之間來回（每格 8 MB，實測約 75 MB/s 收、50 MB/s 送，每格往返約 280 ms），片子裡 3D 超過約 11～15 秒就比統一合成器慢。
- 留給以後參考的 ffmpeg 要點（原專案實測）：局部放大用 `scale=w='iw*z(t)':h='ih*z(t)':eval=frame` 再 `crop`（`crop` 的 w／h 不能逐格變）；遮罩串流不可用 `color`＋`overlay`、不可無限 `-loop 1`、`alphamerge` 前先對齊時間戳；轉場不用 `xfade`（每個實例約 65 MB）；靜音床用有長度的 `anullsrc`，不用 `apad`。

### 5.5 校稿（併進 AI 導演）

校稿候選是 AI 導演建議清單的一種（§5.11）；做法如下，由 Muse Spark 1.3 分批做。

- 桌面把逐字稿分批（約 400 字一批，並行 3～8 批）送到閘道 `/v1/ai/proofread`；Spark 是推理模型，原專案實測每批約 1～2 分鐘、和字數關係不大（2026-09-17、09-25），所以逾時設 300 秒以上；閘道用 `ChatClient` 的結構化輸出拿回疑似聽錯的詞（位置、建議文字、理由代碼）與重複語句（範圍），驗證位置在範圍內再回給桌面。
- 有講稿時一起送，當成術語與原句的參考。
- 介面：候選清單，Enter 採用、Esc 略過，採用即改逐字稿與字幕。

### 5.6 AI 重生語音（P2，D18）

- 選一段字 → 取那段前後的**人聲**當聲音樣本（有做聲音分離時用分離後的人聲，樣本不混音樂）→ 閘道 `/v1/tts` 轉 Fish Audio 生成 → 調整長度對齊原區間 → 產生一個新的音訊片段放在原位置，原本那段人聲靜音；背景音樂軌不受影響。
- Meta 沒有 TTS（模型清單已確認），所以用 Fish Audio；供應商包在閘道後面，之後可換。
- Fish 一律用免費模型 `s2.1-pro-free`（D32；不保證延遲，介面顯示進度）。
- **11/1 已做**（照原專案的操作方式）：
  - 操作：框時間軸範圍 → 範圍動作列「Re-voice」→ 文字預設是範圍內的字，可以改 → Generate。
  - 聲音樣本：從逐字稿挑最長的說話段，湊 20～90 秒；有聲音分離就改用分離後的人聲。
  - 閘道 `/v1/tts`：msgpack 轉給 Fish，串流 WAV 會重包。實測 9.5～14 秒。
  - 長度對齊：先用自然速度生成；太長就加速重生一次（上限 1.3 倍）；還太長再用片段變速。
  - 生成的聲音放在另一條音軌（`Project.voiceovers`）。生效時，範圍內的對白靜音（預覽把增益設 0；匯出加 10 ms 淡出入）；每段可以切回原聲。範圍跟著 AI 片段的位置走。
  - 11/2 補上：生效時範圍內的字幕換成重配的文字（依字元數平均分配時間）；AI 聲音也會讓配樂壓低；新增的音軌標「Voice」。
  - 驗證：`e2e/revoice.spec.ts`、`e2e/revoice-live.spec.ts`（實機）。生成的聲音還沒有人工聽過。
- Fish 的契約（原專案實測 2026-07-21、09-17）：模型用 HTTP header `model` 指定；即時克隆的參考音檔要 raw bytes，請求本體用 msgpack；標記一律方括號 `[break]`（圓括號會被唸出來）；串流 WAV 的標頭長度欄位是錯的（0xFFFFFFFF），要依 fmt 重新包裝；`prosody.speed` 上限 1.3，超過的部分用片段變速；0.2 秒以下的極短區間不要送。

### 5.7 動畫插件與 Vibe特效（P0 核心，2D 與 3D，D19）

- **2D 插件（2026-10-27 開發者改定：沿用原專案字導字演的直譯器）**：原專案的元件格式與受限 JavaScript——定義 `function draw(g, t, p, env, bg)`，透過 `g` 繪圖 API 在 `env.box` 裡畫一格；程式由原專案的直譯器（acorn 解析成語法樹、逐節點白名單、步數與深度上限、拿不到瀏覽器 API）執行，從不交給瀏覽器 eval，這個直譯器再放進下面的沙盒 Worker（雙層防護）。淡入淡出、陰影、描邊、進退場、強調、路徑等「框架屬性」寫在圖層上，插件不必自己做。原檔在 `src/anim/vendor/`（`ORIGIN.md` 記來源與改動），原專案的 202 項單元測試移植成 Vitest（`src/anim/legacy/`）。原 spec 的寫法（原生 JS `render(ctx, t, params, env)`）不採用；3D 插件仍是沙盒 Worker 裡的原生 JS（three.js 跑不進直譯器）。要音效時在 `soundIds` 引用 `Synth`（§5.15）的 id，由合成器在對應時間放進 A3 音效軌，插件本身不發聲（Worker 裡也沒有 `OfflineAudioContext`）。
- **3D 插件（D17）**：一段 JS，匯出 `setup(THREE, scene, camera, env)` 建場景、`update(t, env)` 每格更新；three.js 由我們打包進沙盒（不從網路載），模型對 three.js 很熟，寫起來比自訂 API 可靠。可以只畫疊加物件（透明背景），也可以畫整個畫面（例如影片貼在桌上的螢幕）。
- **`env`（唯讀，2D 與 3D 共用）**——插件和影片互動靠這些：
  - 畫面尺寸、時間、區段長度、使用者框的目標框。
  - **當格畫面**：每格傳一張 ImageBitmap；3D 插件可以拿來當貼圖（例如貼在螢幕上），2D 插件可以取色、找亮處。
  - **定位點**：SAM 找到的物件框、AI 導演標出的位置、使用者在畫面上點的點（吉祥物可以走過去指著它）。
  - **逐字稿與音量**：這個區段的詞與時間、每格的人聲音量（講到關鍵字時做動作、跟著音量點頭）。
  - 固定種子的亂數（同一格每次算出來都一樣，預覽與輸出一致）。沙盒載入插件前覆寫 `Math.random`（固定種子）、`Date.now` 與 `performance.now`（回傳區段時間），插件拿不到真實時間。
- **可重現規則**：畫面只能由 `t` 與 `env` 決定。插件若在 `update` 之間累積狀態（例如物理模擬），預覽跳到別的時間時沙盒會從區段開頭重跑 `setup` 並逐格推到目標時間；輸出一律從區段開頭依序算，所以結果和從頭播放的預覽相同。
- **沙盒**（Q6）：插件在 `sandbox="allow-scripts"`（不給 same-origin）的 iframe 裡的 Worker 執行（3D 用 OffscreenCanvas 的 WebGL2）；只能用我們給的 API 與 three.js；每格限時（2D 30 ms、3D 100 ms），單段最長 60 秒；逾時直接終止 Worker。存檔前先試跑一次。
  - **10/27 實測：Worker 路線可行**（`spikes/sandbox/RESULT.md`，Chromium／Edge 156）：blob URL 建 Worker、Worker 裡 OffscreenCanvas WebGL2、本機打包的 three.js 都能跑；ImageBitmap 雙向轉移 300 格畫素全對；25 項連網檢查全被擋；無窮迴圈在預算內偵測到，`terminate()` 確實殺掉 Worker 並能重建。
  - **CSP**（srcdoc iframe 會繼承父頁 CSP，兩份取交集；Tauri 的 `app.security.csp` 是靜態的，寫不出每次換的 nonce，所以用啟動腳本的 sha256，建置時算）：
    - 父頁：`default-src 'none'; script-src 'self' 'sha256-<HASH>'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; worker-src blob:; frame-src 'none'; base-uri 'none'; form-action 'none'`。`frame-src 'none'` 擋 iframe 自我導航外洩（iframe 自己的 CSP 擋不了）；`script-src` 不加 `blob:`。實際的 `connect-src` 要再加閘道網址。**11/1 已套用**，唯一來源是 `deploy/csp.mjs`：
      - 雜湊在建置時從 `iframeRuntime.js` 算（換行轉成 LF）。
      - 比上面那份多了幾項：`media-src`、`font-src`、`object-src 'none'`。
      - `connect-src` 放行 `'self' https: blob: data:` 和本機 http（因為閘道網址可以在設定裡改，開發者決定）。
      - Windows 版的 img、media、connect 另外加上 `http://asset.localhost asset:`。
      - 套用在三個地方：nginx 由 `web-zeabur.ps1` 填入 `__CSP__`；`vite preview` 用在 e2e；`tauri.conf.json` 的 `devCsp` 另給一份開發用的（`--desktop --dev`：script-src 用 'unsafe-inline'、加 HMR 的 ws）；設成 null 會被當成沒設，開發時就套用正式 CSP，而開發伺服器有 React 的行內前置腳本。
      - 主程式不能再用 `new Function` 執行字串：`plane3d_math.js` 改用 Vite 外掛 `?global=PLANE3D` 當模組載入。
      - `src/sandbox/csp.test.ts` 檢查雜湊和 Tauri 設定一致，`e2e/csp.spec.ts` 檢查完整流程沒有違規。
    - iframe（srcdoc 開頭的 `<meta http-equiv>`）：`default-src 'none'; script-src blob: 'sha256-<HASH>'; worker-src blob:; connect-src 'none'; img-src blob: data:`。
    - 啟動腳本不能用 blob URL（沒有 same-origin 的 iframe 載不到父頁建的 blob）；srcdoc 裡的腳本要和算雜湊的原文逐位元組相同（換行用 LF）。
  - CSP 擋不住 WebRTC（實測 STUN 送出 3 個 UDP 封包）：載入插件前刪掉 `RTCPeerConnection` 等建構子。
  - 時間：除了 `Math.random`、`Date.now`、`performance.now`，`new Date()`、`Intl.DateTimeFormat().format()` 也要覆寫（`spikes/sandbox/public/worker-prelude.js`）；`performance.mark`、`event.timeStamp` 補不了，所以插件拿不到「直接的」真實時間，仍可能推得出相對時間。
  - 每格耗時（Arc 內顯）：轉移約 2.5～5 ms，加 GPU 讀回約 18～36 ms；three.js 一格約 17 ms。軟體算繪（SwiftShader）60～95 ms、three.js 72 ms，接近 100 ms 預算，印證 §5.21 的 720p 做法。
  - **10/27 接進 app**（`src/sandbox/`）：沿用實測過的握手（boot → 控制 MessagePort → lockdown → Worker 資料通道直接交回父頁）；Worker 原始碼＝前置腳本＋acorn＋直譯器＋執行環境＋harness，iframe CSP 用啟動腳本的 sha256；請求 2 秒沒回就整個 iframe 重建。預覽每個特效同時只送一個請求、以最新的為準，暫停時畫格回來就重畫；只有讀 `bg` 的插件才在合成器畫完影像軌那一刻截下層畫面送進去。WebView2 實測（`scripts/desktop-selftest/run.ps1`）：沙盒啟動＋14 個元件驗證 43 ms、畫一格 5 ms，跨來源隔離（COEP）沒被破壞。
  - 退路（iframe 主執行緒）**不採用**：主頁會不會被無窮迴圈卡死，取決於瀏覽器有沒有把沙盒 iframe 放進獨立行程；Chromium／Edge 有，但關掉隔離時主頁永久卡死。WebView2 是否隔離待在 Tauri 裡重測。
- **範本**：2D——**10/27 已有**原專案的 14 個視覺元件（箭頭、框、圈、底線、螢光筆、漣漪、打勾、打叉、徽章、標籤、聚光燈、標題（彈出／打字機／逐字／漸層）、放大鏡、反差框）與 10 個範本，英文名稱在 `anim-library.en.json`；粒子、計數器原專案沒有，要另做（Vibe特效 10/27 實測可以直接寫出彩帶、倒數）。音效元件（8 個）等 §5.15 的音效擺位一起接。3D——螢幕在桌上（§5.8）、吉祥物（基本幾何組成，會走路、揮手、指東西）、3D 箭頭、彩帶、浮起的 3D 標題。模型從零寫的品質不穩，所以 Vibe特效預設拿最接近的範本當底稿修改。
- **外觀參考**：可以先用 Muse Image 畫概念圖（例如吉祥物），再附給 Muse Wonder 當參考圖寫 3D 幾何；也可以匯入現成的 glTF（.glb）模型當素材，模型只寫動作。
- **Vibe特效**：使用者輸入一句描述（可附當格截圖）→ 閘道 `/v1/ai/vibe` 用 `ChatClient`（截圖用 `Media`）請 Muse Wonder（推理深度 medium，D31）回結構化結果（插件程式＋參數定義）→ 桌面沙盒試跑；語法錯、執行錯、逾時就帶同一個對話 id 把錯誤送回閘道，閘道用 `ChatMemory` 接續同一段對話請模型重寫，最多 3 輪。描述與截圖當不可信資料；只准產生畫面動畫（音效另走 §5.15），其他要求回拒答代碼，介面不顯示模型寫的自由文字。是不是特效需求、有沒有越獄或要連網，由 Muse Wonder 在同一次呼叫裡判斷並回拒答代碼（D9，不另外用分類模型）。Wonder 回應較慢，介面顯示「寫程式中」的進度；10/29 實測一輪的耗時，太慢（例如超過 60 秒）就把錯誤回饋重寫那幾輪改用 Spark。**10/27 實測（`scripts/vibe/probe.mjs`，6 題：只填參數、組合、從頭寫、倒數、兩題拒答）**：Wonder（medium）6／6 通過，只填參數或組合一輪 5.6～6.7 秒、從頭寫 2 輪 21 秒（第一輪英文說明超過 120 字被擋、回饋後修好）、拒答 2～2.4 秒；Spark（low）也 6／6，但每輪 7～29 秒，都比 Wonder 慢——**不需要退回 Spark**。經閘道（截圖走 Spring AI `Media`，320×180 的圖約多 85 token）2 輪 37 秒；前端實機（`e2e/vibe-live.spec.ts`）一句話到畫面上 17.8 秒。Spark 的基準（原專案 2026-10-20，21 則描述、推理 low）：新寫插件 3 輪內通過 8／9（89%），平均 41 秒、1 萬 token；只填參數或組合範本約 10 秒；拒答 3～6 秒。常見失敗：每個形狀前沒開新路徑造成殘影、API 的列舉值沒寫清楚就連錯 3 輪——所以插件 API 文件要把列舉值與單位寫全，並用 lint 檢查。
- **10/27 實作**：
  - 閘道 `POST /v1/ai/vibe`（描述 ≤ 500 字＋選填截圖 data URL＋長度／fps／虛擬畫布寬／目標框）→ 202 `{jobId}`；`GET /v1/ai/vibe/{jobId}` 輪詢（running／done／failed）；`POST /v1/ai/vibe/{jobId}/feedback`（沙盒試跑的錯誤）→ 續跑。工作在背景執行緒（4 條），對話存在 Spring AI `ChatMemory`（截圖只在第一輪送，記憶裡存不含圖的文字版），最多 3 輪、6 萬 token，回應格式不對在閘道自動帶錯誤重問；JSON 模式（`json_object`：回應的 params 是開放物件，嚴格 json_schema 表達不了）；只回結構化欄位（拒答代碼，或 mode、anim、components、target），模型的自由文字丟掉；只有建立工作的權杖看得到；用量記在 `usage_log`。
  - 系統提示詞移植原專案 `anim_ai.py`，由 `scripts/vibe/build-prompt.mjs` 從 API 說明檔、元件庫、直譯器禁用清單產生 `gateway/src/main/resources/vibe/system-prompt.txt`（單一來源）。
  - 前端：Vibe FX 頁籤（描述、附當格截圖、第一次用的同意說明、AI 設定：閘道網址與邀請權杖存在這台電腦）；新插件在沙盒 vet（結構、編譯、試跑、參數變體），整段動畫再試畫開頭／中間／結尾三格；拒答與失敗顯示固定文字。
- **輸出**（D24）：同一個 Worker 依時間逐格畫。合成器把當格畫面（下層的合成結果）以 `ImageBitmap` 轉移進沙盒，插件畫好的圖層以 `ImageBitmap` 轉移回合成器疊上；預覽與匯出走同一條路，不經 Rust。音效照 `soundIds` 在離線混音時放進去。只算有插件的區段。
- **畫格傳輸量**：`ImageBitmap` 是 transferable，postMessage 不複製畫素；成本主要在 GPU 排隊。10/27 實測 60 秒 3D 區段每格只多 4～7 ms。軟體算繪的電腦上 3D 圖層用 720p 算再放大（§5.21）。
- **把畫面貼進 three.js 要用 `NoColorSpace`**（RGBA8）＋原樣輸出的材質：10/27 實測用 `SRGBColorSpace` 時每格多 40 ms（60 秒 3D 多 40 秒以上）。畫面本來就是 sRGB 值，不需要轉換。3D 範本與 Vibe特效給模型的 3D API 文件都要寫明。
- 進度與每格限時要以「畫格傳回」為準，不是以命令送出為準（GPU 工作是非同步排隊的）。

- **特效也先框選（D38）**：時間軸有選範圍時，Vibe 的 2D／3D 範本與 AI 產生的特效用範圍的起訖（動作列的「✨ Effect」切到 Vibe 頁籤）；沒有範圍才放在播放頭、用預設長度。

### 5.8 3D 場景與「用說的」（P0 核心，three.js，D19）

- 「平面轉 3D」改成 three.js 的內建 3D 範本（D17），影片畫面當貼圖貼在 3D 物件上：
  - **螢幕在桌上**：木紋桌上平放或立起一塊螢幕，播這段影片；仿之前 YT 宣傳影片的場景。
  - **漂浮的板子**：板子在空間中轉動、推近、拉遠（原本平面轉 3D 的效果）。
  - **教室黑板**、**攝影棚**：背景換成不同場景。
- **鏡頭關鍵幀**：位置、看向的點、視角；錨定區段開頭或結尾；頭尾可以自動接回滿版平面。鏡頭跟著定位點移動（例如跟著畫面上被點的按鈕）。
- 背景：內建場景、模糊原畫面、純色、自訂圖、Muse Image 產生的圖（§5.12）。
- 範本本身就是一個 3D 插件，可以再疊吉祥物等 3D 物件，也可以交給 Vibe特效修改。
- **用說的**：一句描述（可附當格截圖）→ 閘道 `/v1/ai/plane3d` 用結構化輸出拿回鏡頭關鍵幀與場景設定（不是程式碼）→ 閘道驗證範圍與時間順序（不合格回饋重問一次）→ 桌面進入 AI 預覽，按「套用」才寫進專案。要改物件或動作時改走 Vibe特效。原專案實測（2026-10-26，Spark contributor、推理 low、8 秒區段）：8 句 1 輪全部合格；不附圖 1,700～2,700 token、5～14 秒，附 1280 寬截圖 3,000～3,500 token、7～14 秒；無關要求 2 秒拒答。
- 字幕、2D 動畫、疊加軌不跟著 3D 場景轉，留在上層。
- 輸出照 §5.7 的 3D 插件：逐格算、以 `ImageBitmap` 交回合成器。
- **10/27 實作（`docs/plan-10-30.md`）**：
  - 3D 沙盒：獨立的沙盒 iframe（3D 插件卡住重建時不影響 2D），每個 3D 特效一個 Worker；Worker 原始碼＝前置腳本＋three.js（`build/three.cjs` 包成 `THREE` 全域，第一次用到才載入）＋插件程式＋harness。iframe 的 CSP 沒有 `unsafe-eval`，所以插件程式直接串進原始碼、不用 `new Function`。契約 `setup(THREE, scene, camera, env)`／`update(t, env)`，`env.frameTexture`（當格畫面，`NoColorSpace`）與 `env.frameMaterial()`（原樣貼圖）；跳格時從區段開頭重跑（宣告 `pure` 的插件直接跳）；第一格 10 秒、之後每格 2 秒逾時，只終止那個 Worker。安全只靠沙盒（原生 JS 進不了直譯器）。
  - 疊放順序 `layerPlan`（§5.10）：V1 → 3D 場景（`scene3d`，貼 V1 畫面、蓋住 V1）→ V2 以上 → 2D／3D 插件。讀下層畫面的特效把下層狀態（各影片的時間、載好沒）算進請求鍵，下層換了才重畫。
  - 「漂浮的板子」沿用原專案的板子姿勢關鍵幀（`src/three/vendor/plane3d_math.js` 原樣）：`boardGeometry.js` 把四角換成 three.js 相機座標（水平視角 40° 換成垂直視角），投影結果和原專案逐點相同（200 組隨機姿勢誤差 < 0.01 px）；5 個運鏡範本照搬；背景用程式畫（攝影棚、科技格線、模糊原畫面、純色），原專案 Muse 生成的書桌、黑板圖不沿用（商用條款待確認）。
  - 「桌上螢幕」：程式畫的木紋桌、螢幕、杯子（移植匯出實測的場景），頭尾鏡頭沿螢幕法線退到剛好填滿畫面，接原片看不出接縫；reveal／push／orbit。
  - 同一個元件（「Screen in a scene」）有三種場景：木紋桌、教室黑板（影片就是板面，木框、粉筆槽、講桌）、攝影棚（漸層背幕、立架、光錐）；螢幕位置大小相同，運鏡共用。
  - 鏡頭關鍵幀（已實作）：Inspector 列出每個關鍵幀的時間（相對區段開頭）、位置、看向、視角，可在播放頭新增、修改、刪除，每次改動一筆可復原的編輯；有關鍵幀時中段照關鍵幀 smoothstep 內插（`src/three/cameraPath.js`，串在插件前面），頭尾仍接回滿版；沒有關鍵幀用 motion 預設運鏡。鏡頭跟著定位點移動尚未實作。
  - **吉祥物**（anim3d，透明背景疊在影片上）：基本幾何組成，從一側走到目標框旁，指著框或揮手；目標框和 2D 特效一樣可以在預覽上拖。
  - **Vibe特效 3D**：閘道 `/v1/ai/vibe3d`（Muse Wonder、推理 medium、最多 3 輪），提示詞 `scripts/vibe/prompt3d.mjs`（setup／update 契約、`env.toWorld` 把畫面座標換成世界座標、`frameMaterial`、背景透明、不能連網與計時器、物件數與每格 30 ms 的限制）；模型可以只填內建吉祥物的參數，或寫新插件。新插件在 3D 沙盒用暫時的 Worker 試跑（載入、setup、開頭／中間／結尾三格不全透明），語法錯的行號換算成插件自己的行號回饋。10/27 實測：一句「框上方旋轉彈跳的金色星星＋亮片」1 輪 24.3 秒、約 5 千 token。
  - **用說的**：閘道 `/v1/ai/plane3d`（Spark、推理 low、最多 2 輪、1.2 萬 token），提示詞移植原專案 `plane3d_ai.py`，範圍表與提示詞由 `scripts/plane3d/build-prompt.mjs` 從原專案的姿勢數學產生；閘道檢查形狀、範圍、t 不超過區段長度（原專案默默夾住，這裡改成擋下）、換算後嚴格遞增；桌面用同一份數學檢查姿勢路徑，不過就回饋。介面在 Inspector「Describe the move」，提議先預覽、按 Apply 才寫進專案（一筆可復原的編輯）。10/27 實測（`scripts/plane3d/probe.mjs`）：Spark 8／8（方向、時間、路徑都對，拒答 1 句），每句 2～10 秒。

### 5.9 轉場（P2）

> 11/2 已做（`docs/plan-11-02-edit-features.md`）：溶接、穿黑、穿白、左推、右推（推近不做）。不改總長度，沒有多餘畫面時停在第一格／最後一格。在 Inspector 選 V1 片段 → Transition in。

- 在剪輯接點加轉場：溶接、穿黑、穿白、推移、推近；長度可調。
- 接點兩側沒有多餘畫面（手把）時，用兩側的最後／第一格定格補。
- 合成器裡用 shader 混兩側的畫面，預覽與輸出共用（D24）。

### 5.10 疊放順序

B-roll 已併進多軌時間軸的疊加軌（D13、§5.13）。預覽與輸出是同一個合成器（D24），由下到上：

V1 主軌 → 3D 場景（把下面的合成當貼圖）→ V2、V3…疊加軌（子母畫面、外部做的透明素材）→ 2D／3D 動畫插件 → 字幕。遮罩跟著素材，先套在各自的片段上（§5.3）。

### 5.11 AI 導演（P1-1；核心 Vibe特效之後的第二亮點）

**目標**：使用者開一支錄影、按「Ask the director」，幾分鐘後拿到一份剪輯建議清單，逐條按 Enter 採用、Esc 略過。

**模型分工（D12）**

| 角色 | 模型 | 做什麼 |
| --- | --- | --- |
| 統籌 | Muse Wonder（`muse-wonder-1.0`，推理深度 medium） | 看全片摘要與各段報告，決定整體剪輯方向（節奏、哪幾段最重要、哪裡值得加特效），呼叫工具產生具體建議，最後去重、排序、寫每條的一句理由 |
| 苦工 | Muse Spark 1.3（`muse-spark-1.3-contributor`，推理深度 low，D32） | 逐段（約 2 分鐘一段）看縮小的影片＋那段逐字稿，回結構化報告：重講與口誤、畫面上的隱私資訊（臉、Email、API 金鑰、名牌）與時間、適合強調的時刻；也負責校稿、產生 3D 關鍵幀（動畫插件由 Wonder 寫，D31） |

- Muse Spark 一律用 Contributor 版（`muse-spark-1.3-contributor`，D32）；Muse Wonder 只有 Standard 版。Contributor 版送出的內容可能被拿去訓練模型，所以 §3 的同意對話框要寫明這點。
- Muse Spark 1.3 的音訊理解官方標註不完整，所以聲音的部分改給逐字稿文字，影片只送畫面（無聲）。

**流程**（以素材為單位：對素材庫裡一支有聲音的影片執行；要先有逐字稿，沒有就先自動跑 Muse ASR）

1. 桌面把影片縮成約 480p、每秒 2 格、無聲，依逐字稿的停頓切成約 2 分鐘一段；連同逐字稿送到閘道 `/v1/ai/director`（非同步工作，SSE 回報進度）。
2. 閘道把各段平行交給 Muse Spark 1.3（最多 4 段同時），拿回每段的結構化報告。
3. Muse Wonder 拿到全片摘要與各段報告，透過 Spring AI 的工具呼叫（`@Tool`）產生建議：
   - `proposeCut(start, end, reason)`：重講、口誤、太長的停頓。
   - `proposeMask(start, end, target)`：隱私項目；`target` 轉成 SAM 的名詞片語。
   - `proposeEffect(start, end, description)`：要加的動畫，`description` 之後交給 Vibe特效。
   - `proposeCamera(start, end, description)`：要加的 3D 運鏡，之後交給「用說的」。
   - `proposeFix(wordId, text)`：聽錯的詞（校稿）。
   - `proposeZoom(start, end, region)`：畫面上正在操作的地方，建議局部放大（§5.19）。
4. 閘道驗證每條建議（時間在片長內、不重疊、數量上限），回給桌面。
5. 桌面清單依時間排列（素材時間，換算到用到這支素材的片段），點一條跳到那個時間並預覽效果；採用時：剪輯就切開並刪掉那段、遮罩呼叫 SAM、特效呼叫 Vibe、運鏡呼叫 3D、改字直接改逐字稿。每次採用一次 snapshot，可 Ctrl+Z。

**驗收**：用自己的一支 20～30 分鐘錄影，建議清單裡人工判斷「有用」的比例 ≥ 60%；隱私項目（事先在畫面放一個假 API 金鑰）要被找到。

**10/27 實測結果**（`spikes/spring-ai/RESULT.md`，Spring Boot 4.1.2＋Spring AI 2.0.2）：

- **影片不能走 Spring AI 的 `Media`**：2.0.2 把影片當文字片段送出，Meta 回 200 但模型讀到的是 base64 文字（亂答）。Meta 本身收影片，要用 `{"type":"video_url","video_url":{"url":"data:video/mp4;base64,…"}}`。所以逐段看影片的呼叫改用 `RestClient` 直接組 JSON（`response_format`、`reasoning_effort` 自己加，用量從回應的 `usage` 取）。
- 每格約 130 tokens（Spark，480p、每秒 2 格）：2 分鐘一段約 31k、30 分鐘約 47 萬 input tokens；Wonder 約 76／格。素材是靜態投影片，10/31 用範例片再量一次。關鍵格圖片（約 515 tokens／張）也可行，但資訊少，以影片為主。
- Muse Wonder 的一般呼叫、結構化輸出、`@Tool` 工具呼叫在 Spring AI 2.0 都可用；Spark 也能工具呼叫。不需要退回方案。
- Wonder 逐段看影片的結構化回覆品質差（時間超出片長、重複），逐段分析維持 Spark（D12）。
- 耗時：多數呼叫 3.5～6 秒；工具呼叫每輪約 1.5 秒。
- 還沒量：影片大小與長度上限、Files API。

**實作（2026-10-28，`docs/plan-10-28-director.md`）與規格的差異**：
- **Wonder 用結構化 JSON**（`{"suggestions":[…]}`）一次回全部建議，取代 `@Tool` 工具呼叫（開發者選定；沿用「不合格帶錯誤重問一次」，好測、好設上限）。
- **小檔在 WebView／瀏覽器用 mediabunny 轉**（和匯出、SAM 同一條路），不用 Rust ffmpeg；桌面有 540p 代理檔就從代理檔轉（120 秒 8.8 秒，原檔 39 秒）。每段 90～150 秒切在最長的停頓。
- **運鏡由 Wonder 從 3D 範本清單挑場景**（開發者選定），採用時加那個範本，漂浮板子再跑「用說的」。
- **遮罩建議帶 Spark 回報的框**：SAM 3.1 分割不出螢幕上的文字（金鑰、Email），文字類直接用框做長方形遮罩；人、臉、車牌等跑 SAM，找不到才退回框。
- 閘道 `/v1/ai/director`：建工作 → 逐段 multipart 上傳 → Spark（`video_url`＋json_schema strict，同時 4 段）→ Wonder（推理 medium）→ `DirectorRules` 檢查 → 輪詢；聽錯的詞由閘道依詞 id 補時間。
- 實測：demo-2min（含自動轉錄）120.7 秒、9 條建議，假金鑰與重講都找到；lecture-a 282 秒 254 秒、4 條。Spark 約 130 tokens／格（108 秒一段 28k tokens、10.5 秒）。

### 5.12 Muse Image：材質圖、3D 背景、縮圖（P1-14，縮圖屬 P1-7）

- **材質圖**（D36）：一句描述（例如「dark green chalkboard with chalk dust」「worn oak planks」）→ 閘道 `/v1/ai/image`（`purpose: "texture"`）→ 本機後處理 → 存進專案的**材質庫** → 套到需要的地方。
  - 閘道的提示詞模板：描述後面固定加「seamless tileable texture, flat top-down orthographic view, even diffuse lighting, no shadows, no perspective, no objects, no text, edge to edge」；長寬比 1:1、推理 low。
  - **本機後處理**（Worker 裡用 OffscreenCanvas，模型給的圖不保證無縫，見下方實測）：
    1. 縮成 1024×1024（模型實際給 1600×1600）。
    2. 去暗角：大半徑模糊取低頻亮度，除掉後把整張亮度拉平（模型常把四周畫暗）。
    3. 無縫化：位移半張讓接縫跑到中央，再用原圖以十字形羽化遮罩蓋回去（offset-and-blend），四邊接起來看不出縫。
    4. 法線貼圖：亮度當高度、Sobel 算斜率，強度可調（0 就是平的），木紋、磚牆、皮革才有立體感。
    5. 預覽：材質庫顯示 2×2 拼貼，讓使用者確認接縫；不滿意可「再產生一張」或改描述。
  - 資料：`Project.textures[]`：`{ id, name, prompt, color, normal, normalStrength, repeat }`，`color`／`normal` 是素材庫裡的圖片（內容雜湊，和插件一樣存進專案檔）。
  - **套用的地方**：
    - 內建 3D 場景：「Screen in a scene」各場景宣告**材質欄位**（桌面、牆、地板、黑板框、講桌、背幕、地面）；參數型別 `texture`，Inspector 下拉選材質庫的項目或「用說的產生」；沒選就用程式畫的預設（木紋等）。
    - 3D 插件：`env.textures[欄位]` 給 `{ map, normalMap }`（three.js `Texture`，顏色 sRGB、法線 NoColorSpace、RepeatWrapping）；圖片在第一次 setup 前以 ImageBitmap 傳進 Worker，依雜湊快取。
    - Vibe特效 3D：提示詞告訴 Wonder 可以宣告 `texture` 參數並附一句材質描述；沙盒試跑時用灰色棋盤格佔位；插件通過後依描述呼叫 Muse Image 補上材質，使用者可在 Inspector 換掉。
    - 2D 插件：參數型別 `texture`，直譯器的 runtime 增加以圖片填色的 API（`createPattern`，例如金屬字、木紋字）；要擴充 `anim_api_manifest.json` 與提示詞，實作時一併補直譯器測試。
  - 驗證：單元測試（無縫化後左右、上下邊緣像素差低於門檻；全平的圖算出的法線貼圖是 (128,128,255)）；e2e 用假閘道回固定圖片，走「產生 → 材質庫 → 套到教室黑板框 → 預覽畫面看得到材質」；實機另測 3 種描述（木頭、黑板、金屬）看無縫品質。
- **11/1 已做**：
  - 閘道 `/v1/ai/image` 的 `purpose` 多了 `texture`、`background`，走 `/v1/images/generations`。
  - 後處理在主執行緒（`src/texture/process.ts`，純函式）。無縫化改成四份混合（原圖、橫移、直移、兩邊都移，依離邊緣遠近加權），十字遮罩法會在邊緣斷掉。實機三張的接縫差：木頭 46.9 → 14.4，黑板 21.4 → 6.6，金屬 8.6 → 3.7。
  - 材質庫存在 `Project.textures`，材質圖是 `role="texture"` 的素材，素材庫不列出。
  - 3D 插件拿得到 `env.textures[欄位]`。ImageBitmap 不吃 flipY，所以先畫到畫布再做貼圖，否則背景會上下顛倒。
  - 內建「Screen in a scene」有桌面、牆、地板、黑板框的材質欄位與 3D 背景，漂浮板子的背景也可以選「AI image」。
  - Effects → Textures 頁籤；Inspector 的材質下拉。
  - Vibe 3D：插件可以宣告 `texture` 參數（附 `describe`），通過試跑後依描述自動產生材質並套上。試跑時沒有材質，插件要退回純色。
  - 2D 插件的圖片填色還沒做。
  - 驗證：`e2e/textures.spec.ts`（含背景方向）、`e2e/vibe.spec.ts`（自動配材質）、`e2e/textures-live.spec.ts`（實機：每張 23～41 秒）。
- **3D 背景**：輸入一句描述（例如「a cozy classroom with a chalkboard」）→ Muse Image 產生 16:9 背景圖（`purpose: "background"`，不做無縫化），存進材質庫當 3D 場景或板子的自訂背景。
- **影片縮圖**：從成片挑一格當底圖 → Muse Image 依描述改成縮圖風格（不放標題字）→ 標題文字由 WordBlade 用 canvas 疊上 → 縮放成 1280×720。原專案實測（2026-09-12，muse-image-mcp）：`size` 是長寬比字串不是像素（要 1792×1024 實際給 2016×1152），所以一定要自己縮放；`edit` 會整張重畫、小字會壞；圖裡的拉丁字串（網址、名稱）會隨機拼錯，所以字不交給模型畫。
- API（同上實測）：`/v1/images/generations`、`/v1/images/edits`（JSON 帶 `image_url` data URL）回 `data[].b64_json`；預設輸出 webp。
- 走閘道 `/v1/ai/image`，記錄張數（不設上限，D29）；每張約 US$0.01。
- 材質實測（2026-10-27，muse-image-mcp、推理 low、上面的模板加黑板描述）：要 1024×1024 實際給 1600×1600；顏色與質感可用，但四周偏暗、2×2 拼接看得到接縫——無縫化與去暗角一定要自己做。約 4.9k tokens／張。

### 5.13 素材庫與多軌時間軸（P0）

**素材庫**

- 匯入：拖放或選檔，影片、圖片、音樂、音效都可以；ffprobe 讀規格，產生縮圖、波形；需要時在背景產生代理檔（Q5），完成前片段顯示「準備中」。
  - 10/27 實作：Windows 版用 dialog 外掛選檔、Tauri 原生拖放（Windows 上 Tauri 接管 WebView2 的拖放，HTML5 `drop` 收不到檔案；素材庫拖到時間軸因此用滑鼠事件自己做，不用 HTML5 drag）；Rust 指令 `probe_media`（ffprobe，同時把該檔加進 asset 協定的允許清單，不開放整顆硬碟）、`media_thumbnail`、`media_envelope`、`make_proxy`。網頁版用 `<input type=file>`／HTML5 拖放，mediabunny 讀規格與解碼。
  - 匯入**不進復原歷史**（`amend` 套到所有快照，Ctrl+Z 不會讓素材消失）；拖到時間軸（`place` 編輯）可以復原。
  - 音量包絡（每 10 ms 一個 RMS）在匯入時算好，時間軸波形與配樂壓低共用；它是衍生資料，不存進專案、不進歷史。Windows 版由 ffmpeg 解成 8 kHz 單聲道 PCM 在 Rust 算，網頁版用 mediabunny 串流解碼算。
  - 代理檔：540p（高 540、寬依比例）H.264＋AAC、關鍵幀 1 秒、`+faststart`（預覽的 `<audio>` 也用代理檔，所以要帶聲音）；專案檔做好之前先放 `%LOCALAPPDATA%\com.wordblade.app\proxies\`，檔名是原檔「路徑＋大小＋修改時間」的雜湊（FNV-1a），同一支重複匯入直接重用、原檔改過就重產；啟動時刪掉 30 天沒用到的與中斷留下的 `*.part.*`。完成前預覽先用原檔；代理檔路徑記進 `Media.proxyPath`（不進復原歷史）。帶透明的影片產生 VP9 透明 WebM（`libvpx-vp9`、`yuva420p`、`-auto-alt-ref 0` 才保得住透明，聲音 Opus），10/27 實測 50% 透明的測試片解碼後 alpha 平均 127。
  - 網頁版不做代理檔（§5.21），只收 H.264／AAC 的 MP4、MOV，圖片，WAV、MP3、M4A；其他格式提示改用 Windows 版。素材只存在這次分頁（blob 網址），重新整理就沒了，等存開專案時改存 `FileSystemHandle`。
  - 程式開啟時是空專案（V1、V2、A1 對白、A2 配樂、A3 音效），標題列有「Load demo」載入示範專案；e2e 用 `?demo=1`。Windows 版的 Load demo 由 Rust `find_samples_dir` 從執行檔與目前目錄往上找 repo 的 `samples/`（並放行讀取），安裝版沒有示範素材就提示。換專案時釋放舊素材的縮圖與 blob 網址。
  - mediabunny 只在網頁版匯入時動態載入（獨立分塊約 700 kB），桌面版與首次載入都不下載。
- 尺規拖曳（scrub，開發者 2026-10-27 要求）：在時間軸上方的尺規按住左鍵拖曳播放頭，預覽即時更新到指針所在畫面；播放中按下會先停。暫停時元素還在拖動（`seeking`）就不再設 `currentTime`，等 `seeked` 重畫時對到最新位置（否則每次滑鼠移動都中斷上一次拖動，畫面出不來）。
- 播放頭把手與介入（D39，開發者 2026-10-28）：尺規上的倒三角把手跟著播放頭；軌道空白處按住也能拖曳（片段與特效上仍是選取與拖曳）；拖曳時把手旁浮出時間碼，滑鼠移動合併到下一個畫格才送一次。**任何移動播放頭的操作都停止播放或倒退**（reducer 的 `seek` 一律停止並清掉試聽的 `stopAt`；停止後排在途中的 `tick` 忽略；`play` 遞增 `playSeq` 讓預覽的播放迴圈從新位置重起）。
- 區塊大小（D39）：三條分隔線（`Splitter`，pointer capture，雙擊回預設 380／300／88 像素），`ui/layout.ts` 讀寫 localStorage `wordblade.layout` 並夾住範圍；CSS 再用 `clamp()` 限制面板不超過 60% 寬、時間軸不超過 70% 高。
- 漸進式縮圖（D39，開發者 2026-10-28）：三層——每 10 秒寬 160、每 2 秒寬 320、每 0.5 秒寬 480（`media/thumbs.ts`），每層以 60 秒為一段產生（三種間隔都整除，索引＝時間÷間隔）。第一層在匯入時、做代理檔之前從原檔做（桌面 ffmpeg 只解關鍵幀，10/28 實測 11 分鐘 1080p 約 12 秒）；第二、三層由背景排程（`ThumbScheduler`）在空檔一段一段做，桌面版從 540p 代理檔解（282 秒的代理檔：第二層 2.9 秒、第三層 3.7 秒）。快取：桌面 `%LOCALAPPDATA%\com.wordblade.app	humbs\<原檔鍵>	<層>\<索引>.jpg`（鍵＝路徑＋大小＋修改時間的雜湊，和代理檔同一個；每段做完寫 `c<段>.done`；30 天沒用到啟動時刪），網頁 OPFS `thumbs/<鍵>/t<層>/`；重開專案讀完成標記，不重做。用途：①暫停中拖播放頭，影片還在跳轉時若縮圖比畫面上那一格更接近目標就先畫縮圖（合成器照常疊字幕、特效；逐格移動時不換，避免閃）；②時間軸影片片段的影格條（每格約 60 像素、最多 300 格，取做好的最細一層）；③`ThumbStore.thumbnailAt` 給 AI 導演逐段取畫面（Vibe 仍用預覽的合成畫面）。
- 每支有聲音的影片可以各自跑 Muse ASR、AI 導演、SAM；結果存在那支素材上。
- 拖到時間軸：影片到 V 軌，**聲音直接分離**成 A 軌上獨立的片段（D15：兩者不連動，可以各自移動、修邊、刪除）；圖片到 V 軌（預設 5 秒）；音樂與音效到 A 軌。拖到 V1 時插在離放開位置最近的剪接點，依 D25 反向漣漪（後面的片段與其他未鎖定軌一起右移，跨在插入點上的切開；特效右移或拉長，開發者 2026-10-27 定）；其他軌放在放開的時間、不漣漪。雙擊素材：影片與圖片接在 V1 結尾。
- 改字即剪與 V1 的漣漪刪除：照 §4 的跨軌規則（同素材的 A 片段一起剪，其他未鎖定軌一起位移）；其他情況影音各自獨立。

**軌道**

- V1 主軌：片段首尾相接，漣漪剪輯。
- V2 以上：疊加軌，可以有空隙；片段可設全畫面或子母畫面（在預覽上拖曳調框）、透明度、淡入淡出；帶透明的素材（例如外部做的 3D 吉祥物動畫）直接疊上。
- A 軌：A1 放分離出來的主音（講話）；A2 配樂（循環、淡入淡出、有人講話時自動壓低）；A3 音效。每軌與每段可調音量、靜音。

**介面（D15）**

- 版面照原專案（SubTutor）的混合模式（D33；參考畫面 `transcript-review/output/ui-shots/mode-mixed.png`）：
  - **上方標題列**：產品名、專案檔路徑、最近開啟、自動存檔狀態、匯出。
  - **左側大預覽**：預覽畫面（可直接在上面拖框：子母畫面、局部放大、定位點），下方播放控制（逐格、播放、縮放、CC 字幕開關、時間碼、剪後／原片長度）。
  - **右側編輯面板**（D39 取代原本的四組平鋪頁籤）：上排 6 個大類別、下排子頁籤——Media（素材庫）｜Transcript（逐字稿＋轉錄與清理、字幕樣式）｜Effects（2D：Vibe 描述＋2D 範本；3D：Vibe 描述＋3D 場景；Zoom；Mask；Sound 音效與配樂）｜Inspector（選取中的片段或特效的屬性）｜AI Director｜Export（匯出、發佈包）。回到某個大類別時打開它上次的子頁籤。
  - **下方多軌時間軸**：上方工具列（復原、重做、切割、吸附、縮放），V1 縮圖＋片段上方的特效標籤列，V2 以上疊加軌、S1 字幕軌、A 軌波形。
  - **最底下一行**：熱鍵提示。
- 只做這一種版面，不做模式切換；區塊之間的分隔線可以拖曳調大小。

**合成預覽**

- 畫面：§5.4 的 WebGL 合成器畫在預覽的 canvas 上。V1 用兩個 `<video>`（代理檔）交替當貼圖來源（下一段預先載入），切換時不閃黑；V2 以上每個可見片段一個 `<video>`／`<img>`；全部跟著同一個主時鐘同步（用 `requestVideoFrameCallback` 取格，偏差超過 1 格就校正）。
- 聲音用 Web Audio 混：A 片段一律用 `<audio>`＋`MediaElementAudioSourceNode`（變速時 `preservesPitch` 只對 media element 有效；`AudioBufferSourceNode` 的 `playbackRate` 會連音高一起變）；配樂壓低用和匯出同一條增益曲線（§5.4）。原專案 2026-10-20 在 WebView2 遇過接上 `MediaElementAudioSourceNode` 後整條靜音（Chromium 重現不了，推測是 `AudioContext` 停在 suspended，且 `createMediaElementSource` 接上就拆不掉）：`AudioContext` 要在使用者手勢裡建立並 `resume()`，10/28 在 WebView2 必測；不行就單段音量退回 `el.volume`、壓低曲線改在 rAF 裡設 `el.volume`。
  - **10/27 實測（WebView2，`scripts/desktop-selftest/run.ps1`）：沒有靜音**。`<audio>` 接上 `MediaElementAudioSourceNode` 後總輸出 RMS 0.06～0.08、`AudioContext` 是 running。關鍵是**元素要在設 src 之前設 `crossOrigin = "anonymous"`**：頁面在 `http://tauri.localhost`、素材在 `http://asset.localhost`（跨來源），不設的話 Web Audio 只會拿到靜音（Chromium 開發時素材同來源所以重現不了，推測就是原專案靜音的原因）；Tauri 的 asset 協定會回 `Access-Control-Allow-Origin`（＝視窗來源）。`<video>`、`<img>` 也要設，否則 WebGL 貼圖被汙染。
  - 實作：`src/audio/audioGraph.ts`（片段增益 → 軌道匯流排 → 總輸出），第一次按播放（按鈕或 Space／J／L）時建立；配樂壓低是純函式 `duckingCurve`（`src/audio/ducking.ts`：對白包絡超過門檻 0.02 → 增益 0.3，壓下 80 ms、回復 600 ms、講完再撐 300 ms），預覽每格查曲線設配樂匯流排增益，匯出要用同一條。
- 3D、動畫、字幕照 §5.10 的順序在合成器裡疊上。

**做不出來的效果用素材補（D14）**

- 例如 3D 吉祥物走動、真 3D 場景：在外部（three.js、Blender 等）做成帶透明的影片（ProRes 4444 或 VP9 透明 WebM），匯入素材庫放到疊加軌。
- 這是剪輯軟體的正常用法；demo 影片裡用到的外部素材在 README 註明來源。

### 5.14 聲音分離：人聲／背景音樂（P1-10，D16）

**目標**：一支素材的聲音拆成「人聲」與「背景音樂」兩個獨立片段，各自調音量、剪輯、靜音；例如去掉原片的音樂換成自己的配樂，或只留音樂。

**模型**（本機執行，不上傳）

| 模型 | 輸出 | 授權 |
| --- | --- | --- |
| Kim_Vocal_2（MDX-Net ONNX，66,759,214 bytes） | 人聲 | **上游授權不明**（原專案 2026-10-22 查證：TRvlvr/model_repo 沒有 LICENSE、作者 repo 不含權重、UVR 只說程式是 MIT）。提交前要確認或在 README 註明 |

- **只跑一個模型（D28）**：背景音樂＝原音減人聲（UVR 的 secondary stem 作法），不再跑 Inst_HQ_3。
- 推論做法參考 python-audio-separator（MIT）：STFT → ONNX 推論 → iSTFT，分段處理並重疊接合；在 Rust 層用 `ort`（onnxruntime）＋`rustfft` 實作，Windows 先試 DirectML（內顯），不行退回 CPU。README 與關於頁列出模型與 python-audio-separator 的授權。
- 已知速度（作者先前實測，CPU）：19.2 秒的音訊，人聲模型約 46 秒（約 2.4 倍片長）；DirectML（Intel 內顯）11.3 秒（約 4 倍快、0.6 倍片長），輸出和 CPU 一致（原專案 2026-10-20）。壓限器 `alimiter` 有 5 ms 前瞻會讓 stem 延後 5 ms，分離流程不要用有前瞻的壓限器。模型檔的 SHA-256 要自己算（audio-separator 印的是 32 字元的 hash，不是 SHA-256）。長片在背景跑、顯示進度、可取消；結果依「素材＋模型」快取在專案的 `stems/`，不重算。
- 模型檔不放進 repo：第一次用時下載到使用者資料夾並驗 SHA-256（安裝檔不必大 64 MB）。
- **只有 Windows 版**：網頁版不做聲音分離（onnxruntime-web 是重複實作，而且這項在砍除順序的前段），選單顯示「Available in the Windows app」。

**11/1 已做（桌面版）**：
- Rust 推論在 `src-tauri/src/stems`，用 `ort`（onnxruntime，靜態連結），先試 DirectML、失敗退回 CPU，DirectML.dll 和程式一起打包。從 `spikes/mdx-rust` 移植，和 numpy 版相差 >124 dB。
- 模型第一次用時下載到 app 資料夾的 `models/` 並驗證 SHA-256 `ce74ef3b…9c8b`。實測下載加分離 82 秒。
- ffmpeg 解成 44.1 kHz 立體聲後串流處理，有進度、可以取消。結果依內容指紋快取在專案的 `.data/stems/`（沒開專案時放 app 快取）。
- 素材庫的「Separate」按鈕：原本的音訊片段換成人聲（留在原軌）加背景（新的 music 軌），位置與修邊相同，一次 Ctrl+Z 復原；`Media.stems` 記錄兩者的關聯。
- 轉錄與 AI 重配音的聲音樣本改用分離後的人聲。網頁版按鈕停用。
- 速度：DirectML 第一次會先編譯（4 秒的音訊約 62 秒），之後 4 秒音訊約 11 秒；CPU 約 0.4 倍即時。
- 11/2 安裝版驗證過（`scripts/verify-installer.ps1`）：DirectML.dll 裝在 exe 旁邊；安裝後用 DirectML 分 4 秒的音訊只要 3.8 秒（release 版）。新 clone 要先 `cargo build`，再跑 `scripts/fetch-directml.ps1`。

**介面與時間軸**

- 素材庫或 A 片段的右鍵選單「Separate vocals / music」。
- 完成後，原本的 A 片段換成兩個片段：人聲留在原軌（A1），背景音樂放到新增的一條 A 軌，位置、修邊與原片段相同；兩者不連動（D15）。
- 分離後的人聲有三個額外用途：
  - Muse ASR 改送人聲（背景音樂不干擾，辨識更準）。
  - 配樂自動壓低的「有人講話」判斷改看人聲的音量。
  - AI 導演的逐段分析一樣用人聲的逐字稿。

**輸出**：人聲與背景音樂就是兩個普通的音訊素材（WAV），匯出照一般的多軌混音處理。

**三軌拆分（人聲／音樂／音效）與 Demucs：先實測（D18）**

- MDX-Net 只分得出「人聲」與「其他」，原片內嵌的音效會跟音樂混在一起。
- 10/27 實測兩件事：
  1. Meta 的 Demucs（`htdemucs`，MIT）：人聲品質和 MDX-Net 比，以及能不能在 Rust 用 ONNX 跑（或改在 Modal／Baseten 上跑）。換成 Demucs 就多用一個 Meta 開放權重模型。
  2. 找得到能分出「對白／音樂／音效」的開放模型就試；分得出來才做第三軌（音效放到另一條 A 軌）。
- 兩項都不理想就維持 MDX-Net 兩軌，不影響其他功能。

### 5.15 AI 音效與 AI 音樂（D18、D27）

**宣告式音訊（D27）**：模型不寫程式，只回一份 JSON，由我們的 TS 解讀器建 Web Audio 節點、用 `OfflineAudioContext` 在主程式算成 WAV。不執行模型產生的程式，所以沒有無窮迴圈或偷連網的問題，也不必進沙盒；閘道用 JSON Schema 驗證，不合格回饋重問一次。

- 音效 spec：聲部清單，每個聲部是來源（振盪器波形與頻率曲線，或白／粉紅雜訊）→ 濾波器（種類、截止頻率曲線、Q）→ 振幅包絡（ADSR）→ 選用效果（延遲、殘響、失真），加總長度與音量。
- 配樂 spec：速度、拍號、小節數、和弦進行、各聲部（貝斯、和弦墊音、琶音、鼓組）的音色（同上的聲部定義）與音符表；長度剛好是整數小節，首尾可以無縫循環。

**實作（10/28，`docs/plan-10-28-audio.md`）**

- schema 只有一份：`src/audio/synth/synth.schema.json`（入口 `#/$defs/sound`、`#/$defs/music`）。前端 `schemaLite.ts` 與閘道 `SchemaLite.java` 是同一套 JSON Schema 子集（type、properties、required、items、範圍、enum、pattern、anyOf、`$ref`），多餘欄位丟掉、錯誤文字相同；schema 表達不了的（曲線 t 遞增、音符落在 loopBars 內、長度與音數上限）另外檢查。`validationCases.json` 前端與閘道都跑。閘道的 schema 複本與提示詞由 `node scripts/synth/build-prompt.mjs` 產生。
- 音效 spec：`{length 0.05～10 秒, gain?, seed?, voices: 1～8 個}`；聲部＝音色＋`start?`、`dur?`（按住多久，之後 release）、`repeat? {count, every}`。音色＝`source`（`{type:"osc", wave, freq, detune?}` 或 `{type:"noise", color: white|pink}`）、`filter? {type: lowpass|highpass|bandpass|notch, cutoff, q?}`、`env {attack, decay, sustain, release}`、`gain?`、`effects? {delay {time, feedback, mix}, reverb {decay, mix}, distortion {amount}}`。曲線是一個數字或 `[{t, v}]`（t 從這個音開頭算，點之間指數過渡）。
- 配樂 spec：`{bpm 60～180, beatsPerBar? 2|3|4, bars 1～32, chords: 每小節一個（Am、Fmaj7、G7…，不夠就循環）, gain?, seed?, parts: 1～6 個}`；聲部 `{role: bass|pad|arp|lead|drums, voice?（drums 以外必填）, gain?, loopBars?, notes}`；音符 `{at, len（拍）, pitch?（MIDI）| chord?（和弦第幾個音）+ octave? | drum?（kick、snare、hat、openhat、clap）, vel?}`。長度＝bars × beatsPerBar × 60 ÷ bpm，上限 120 秒、展開後最多 3000 個音。
- 解讀器（`render.ts`）：每群音（同音色）共用一條效果鏈；雜訊與殘響脈衝響應用固定種子，同一份 spec 每次算出的 WAV 位元組相同。配樂多算一段尾巴再疊回開頭，長度剛好整數小節、首尾無縫；峰值超過 0.89 整體縮小；輸出 48 kHz 單聲道 16-bit WAV。
- 閘道：`POST /v1/ai/sound`（description、length、previous?）、`POST /v1/ai/music`（description、bars、previous?）→ 202 `{jobId}`，`GET …/{jobId}` 輪詢（同 plane3d 的 AiJobs）。模型 Muse Spark（`wordblade.models.spark`，推理 low），只回 JSON；音效 length、配樂 bars 要等於請求的值；不合格自動帶錯誤重問一次（最多 2 輪），拒答只有 `off-topic`。用量記在 `/v1/ai/sound`、`/v1/ai/music`。前端拿到 spec 再驗證一次。
- 產生的 WAV 經 `Engine.importGenerated` 變成一般素材：Windows 版 Rust `write_generated` 寫進 app 資料夾的 `generated/`（檔名淨化、不覆寫、放行 asset 協定），網頁版包成 File；再走 `importSources`。**11/1**：
  - 開著專案資料夾時，產生的檔案改寫進 `.data\generated\`；Windows 版用標頭 `x-project-dir` 告訴 Rust 寫到哪個專案。
  - 進素材庫時同時存一筆 `Synth`（spec、label、prompt、renderedMediaId；編輯 `addSynth`，可以復原）。音效頁籤的「In this project」會列出來，點了重新算樣本，素材還在就沿用，重開專案後還能 Play、Modify、Regenerate。
  - 配樂放進比一圈長的範圍時，接著重複放滿，最後一段剪到範圍結束（編輯 `placeLoop`）。
- 介面：特效 → 音效（Sound）子頁籤。上半音效：10 個範本（whoosh、pop、ding、typing、rise、fall、click、sweep、impact、sparkle）點了直接算、不送任何資料；或描述＋長度按 Generate。下半配樂：描述＋小節數（4／8／16）、Generate、Regenerate（同描述再來一次）、Modify（修改指示＋前一版 spec）。都有 Play（共用 AudioContext 預覽）、Save to media、Add to timeline（音效 → 音效軌 A3、配樂 → 配樂軌 A2；有選範圍放在範圍起點，否則放在播放頭；一次復原）。第一次用 AI 顯示同意說明（送到 Muse Spark，Contributor 版的內容可能被 Meta 用於訓練，D32）。

**AI 音效（P1-8）**

- 一句描述（例如「whoosh」「keyboard typing」「pop」）＋長度 → 閘道 `/v1/ai/sound` 請 Muse Spark 回音效 spec → 解讀器算成 WAV → 進素材庫，可以直接放到 A3 音效軌。2D 範本的音效（§5.7，11/1）跟著特效走：存在特效參數 `sounds`（元件雜湊＋參數＋at）與 `soundGain`（0～1，0＝關掉），沙盒算事件、主程式算成聲音，預覽當一個跟著特效的聲音播、匯出混進音軌（`src/anim/effectSound.ts`）。
- 內建 10 個範本 spec（whoosh、pop、ding、打字、上升音、下降音、點擊、轉場掃頻、撞擊、閃亮），不用 AI 也能用，同時是模型的例子。

**AI 音樂（P1-11，WebAudio 版）**

- 一句描述（風格、速度、情緒）＋小節數 → 閘道 `/v1/ai/music` 請 Muse Spark 回配樂 spec → 解讀器算成 WAV → 素材庫、A2 配樂軌。
- 音色偏合成器，適合當科技類影片的背景配樂；可以「再生成一次」或「改一下」（帶著前一版 spec 修改）。目前放一段（一圈）；選了較長的範圍時接著重複放滿，之後再做。

**AI 音樂（P2，Meta MusicGen）**

- Meta AudioCraft 的 MusicGen（開放權重）部署在 Modal 或 Baseten（黑客松合作夥伴各送 100 美元額度），閘道 `/v1/music` 轉送：描述＋長度 → 音樂 WAV。
- 品質比 WebAudio 版好很多，也多用一個 Meta 開放權重模型；但**權重授權是 CC-BY-NC 4.0（非商用）**，只限黑客松展示，之後商品化要換掉。
- 約 1 天（部署＋轉送），P1 都完成才做。

### 5.16 一鍵去贅詞（P1-4，D20）

- 贅詞清單：英文 um、uh、erm、ah、hmm；中文 呃、嗯、欸。「like」「you know」「那個」「就是」這類有時是正常用詞，預設不勾，使用者可以加進清單。
- 從逐字稿找出贅詞 → 列表（每條可試聽）→ 「Remove all」一次剪掉（同改字即剪：切開、刪掉、V1 漣漪補位），一次 snapshot 可 Ctrl+Z。
- **Muse ASR 可能會保留贅詞**：原專案的中文實測（2026-09-16）Muse 保留「呃」「好」「吼」，吞掉的是 Groq 與 faster-whisper；英文沒測過，10/31 用英文錄影確認。沒有保留的話，改從聲音找：兩個詞之間有聲音、卻沒有對應文字的短片段（0.15～1 秒），列為「疑似贅詞」，一樣讓使用者試聽確認。
- **實作（10/28）**：`findFillers`（V1 上用到的詞，比對時忽略大小寫與頭尾標點，前後各留 0.05 秒但不超過前後的詞）＋確認清單（逐字稿頁籤上方，和 §5.16b 共用；每條可試聽：播到該段結束自動停）＋「Remove selected」用 `cutRanges` 一次剪掉。真人英文實測（FOSDEM 180 秒）找到 17 條（um、uh、hmm、ah），Muse 有保留真人的語助詞，暫不需要聲音退路。
- AI 導演的 `proposeCut` 也會把明顯的贅詞與口吃列進建議。

### 5.16b 清除無聲片段（P1-13，開發者 2026-10-27 要求列入）

- 從對白軌（A1）片段的音量包絡（§5.13，匯入時已算好）找無聲段：RMS 低於門檻（預設 0.01，約 -40 dBFS）且持續 ≥ N 秒（預設 1.0，可調）。
- 每段前後各留 0.15 秒，不切到逐字稿的詞（和詞重疊就縮到詞的邊界）；換算到 V1 上用到這支素材的片段。
- 和去贅詞共用確認清單介面（每條可試聽、可取消勾選）→「Remove all」從後往前用 `rippleDelete` 剪（D25 跨軌規則），一次 Ctrl+Z 復原。
- 純函式（輸入包絡、片段、詞與參數 → 範圍清單），Vitest 測；沒有逐字稿也能用（只看包絡）。
- **實作（10/28）**：`findSilences`（詞在無聲段中間時拆成兩段）；範圍一律用素材時間記，`cutSourceRanges` 換算到 V1 片段、合併重疊（分開剪會多剪到往前補過來的內容）再從後往前 `rippleDelete`——改字即剪、去贅詞、清除無聲共用。e2e 素材 `e2e/fixtures/gaps.mp4`（兩段 1.5 秒無聲）。

### 5.17 發佈包（P1-7，D20）

- 剪完後按「Publish kit」：閘道 `/v1/ai/publish` 把成片的逐字稿（換算成成片時間）交給 Muse Spark，結構化輸出：
  - 3 個標題選項、影片說明（含重點條列）、章節（`0:00 Intro` 格式，時間對應成片）、標籤。
- 縮圖：從成片挑一格（或使用者指定）→ Muse Image 改風格 → WordBlade 疊標題字、縮放成 1280×720（§5.12）。
- 匯出：`publish.md`（標題、說明、章節、標籤）與 `thumbnail.png` 和 MP4 放在同一個資料夾；介面有「複製」按鈕可直接貼到 YouTube。

**實作（10/29，計畫 `docs/plan-10-29-publish.md`）**

- 開發者決定：縮圖一起做；文字用逐字稿的語言（介面可改）；檔案跟匯出的 MP4 放一起，檔名 `<名>.publish.md`、`<名>.thumbnail.png`（匯出時寫，沒有發佈包就不寫）。
- 閘道：`POST /v1/ai/publish`（JSON：language、duration、lines）與 `POST /v1/ai/image`（multipart：purpose＝thumbnail、prompt、image），都是輪詢工作；逐字稿上限 6 萬字元（前端超過 5 萬先從中間截掉並提示）。
- 章節：模型給的時間先對齊最近的送出行首（±5 秒內，否則丟掉），再套 YouTube 規則（0:00 起、相鄰 ≥ 10 秒、至少 3 個，不夠就不放並提示）。
- 縮圖：底圖是播放頭這一格（預覽畫面，會帶燒進去的字幕）；可以直接用，或請 Muse Image 改風格（約 20～30 秒）。標題由 WordBlade 疊（最多 2 行、縮字），不交給模型。Muse Image 實測：`size` 要 `WxH`，1792x1024 回 2016×1152 WebP；要求「不畫字」時模型會把畫面上原有的文字一起抹掉。
- 文字存在 `Project.publish`（跟著專案存）；縮圖只在記憶體，重開專案要再做一次。

### 5.18 逐字高亮字幕與重配錄音卡拉 OK 模式（D20）

**逐字高亮字幕（P1-3）**

- 字幕樣式多一個「Karaoke」：目前講到的詞變色（或放大、加底色），用 §5.2 重建的詞級時間。
- 做法（D37）：`wordStates` 依詞級時間算出每個詞是講過／講到／還沒講（詞與詞之間的空檔維持上一個詞；最後一個詞講完後全部算講過），`CaptionLayer` 依樣式畫：填色（講過與講到的上色）、放大（講到的放大 1.18 倍）、底色（講到的加底色塊）。預覽與匯出同一段程式。
- 幾種預設：黃色填色、整詞放大、底色塊跳動；可調顏色與字型。

**重配錄音卡拉 OK 模式（P1-9）**

- 用途：某段講錯、或想重講得更好，又要和原本的節奏、畫面對得上。
- 流程：在逐字稿選一段字 → 按「Re-record」→ 提詞器全螢幕顯示這段字，倒數 3 秒後**照原本的時間逐字高亮**（像卡拉 OK），播原畫面（原聲靜音或小聲）→ 使用者跟著念，麥克風同步錄音 → 錄完可以試聽、重錄。
- 套用：新錄音變成 A 軌上的一個片段放在原位置，原本那段人聲靜音；長度差 ±15% 內自動設片段變速對齊原長度（保持音高，§5.20），超過就提示。
- 提詞器的字可以先改（例如改掉講錯的字），高亮時間照原本的詞時間按字數比例分配。
- 麥克風：WebView2 的 `getUserMedia`。10/27 實測（`spikes/tauri-env/`）：WebView2 會跳權限詢問，沒人按就一直等。做法：Rust 端處理 WebView2 的 `PermissionRequested`，自動允許麥克風（不跳詢問）。**10/27 已做**：Tauri 2.12 的 `Builder::on_permission_request` 只放行 `PermissionKind::Microphone`、其他照平台預設（不必自己接 COM）；實測不再逾時，權限放行後在作者公司電腦回 `NotReadableError`，同機的 Edge 也一樣（`scripts/desktop-selftest/mic-edge-check.mjs`），是裝置層被擋（下句的 Kaspersky），實際錄音要換電腦驗。作者的公司電腦上 Kaspersky 依程式信任等級擋錄音（原專案 2026-10-18：所有 WASAPI 初始化都回 `0x80070057`，Rust／ffmpeg 一樣被擋，只有微軟簽章的程式能錄），所以「改由 Rust 錄音」不是有效備案。**退路（開發者 2026-10-27 決定，P1-9 實作）**：預設用 `getUserMedia`＋`MediaRecorder`；Windows 版遇到 `NotReadableError`、`NotAllowedError` 或 8 秒逾時，自動改用原專案（字導字演）的做法——Rust 以內嵌的 ASCII PowerShell 腳本（`powershell.exe` 5.1）從 `shell:AppsFolder` 喚起 Windows 內建錄音機（`Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe`，微軟簽章、不是本程式的子程序），用 UI Automation 按 `RecordButton`／`StopRecordingButton`、把視窗縮到最小尺寸停在右下角；起訖時間讀 `HKCU\...\CapabilityAccessManager\ConsentStore\microphone\<套件>` 的 `LastUsedTimeStart`／`Stop`（FILETIME，毫秒級）；停止後在「文件」底下找修改時間最接近停止時刻的 `.m4a`，搬進 app 資料夾再匯入（原專案 `backend/narration.py`，2026-10-19 在 Kaspersky 機器實測可錄）。`NotFoundError`（沒有麥克風）不退，直接提示；網頁版沒有退路，只提示。提詞器顯示這次用了哪種方式。錄前先試開麥克風、錄後檢查峰值，削峰時提示（原專案的爆音主因是錄音裝置增益 96%，`adeclip` 可後製去削峰）。
- 和 AI 重生語音（§5.6，P2）是兩種選擇：自己念，或讓 AI 用你的聲音念。


**錄音（11/1，卡拉 OK 重配錄音本身還沒做）**：音效頁籤的「Voice recording」可以錄一段，放進素材庫或放上對白軌。
- 預設用 `getUserMedia` 加 `MediaRecorder` 錄音，再解碼成 48 kHz 單聲道 WAV（`src/audio/micRecorder.ts`）。
- 退路照上面的決定：Windows 版遇到 NotReadableError、NotAllowedError 或 8 秒逾時時，改用 Rust 的 `recorder_start`、`recorder_stop`，執行內嵌的 `scripts/recorder/sound-recorder.ps1`（從原專案 narration.py 移植，純 ASCII）。停止後把 m4a 複製進專案的 `.data\generated\`，再走一般匯入。
- NotFoundError（沒有麥克風）不走退路，直接提示；網頁版沒有退路。
- 錄完峰值達 0.99 會提示削峰。
- 驗證狀況：
  - `e2e/recording.spec.ts` 用 Chromium 的假麥克風測過。
  - 退路腳本在作者的電腦（有 Kaspersky）上手動跑過一次 start／stop，拿到 m4a。
  - 從 Windows 版介面觸發退路還沒有人工點過。

### 5.19 局部放大（P1-2，D20、D38）

照字導字演的做法（開發者 2026-10-28 要求）：
- **建立**：時間軸 Shift＋拖曳選範圍 →「🔍 Zoom」→ 範圍起點所在的 V1 片段的素材範圍變成一段放大（預設框寬 0.5＝2 倍、一個路徑點在中央），接著進入調框。
- **資料**：`Project.zooms`（`ZoomRegion`，§4）：素材時間的起訖、固定框寬 w、框中心的路徑點；用素材時間記，剪輯後跟著素材走，一段放大跨過剪接點時在時間軸上會變成兩條。
- **數學**（`src/core/zoom.ts`，照搬原專案 `backend/zoom_math.py` 與它的測試）：頭尾緩動固定 1 秒（區段短於 2 秒取一半），ease-in-out quad；路徑點：第一點前與最後一點後停住，兩點相同停住、不同時 ease 移動；倍率 S＝1＋(1/w−1)·p，原專案的平移換算成畫面中央看到的素材位置＝0.5＋(c−0.5)·(1/w)·p／S，再換成要取的畫面範圍（`zoomCrop`）。
- **時間軸**：V1 底部的放大條（`ZoomBands`）：拖條本身移動整段（路徑點跟著走）、拖兩端修邊（都夾在那個片段的素材範圍內，不跨片段）、菱形是路徑點（點一下選取並跳過去、Delete 刪那一點，至少留一點）、條本身 Delete 刪整段。放開才寫回（一筆可復原的編輯）。
- **預覽上的放大框**（`ZoomEditOverlay`）：調框時預覽顯示沒放大的畫面；拖框：沒選路徑點時整段平移（位移先夾到每一點都不出界），選了點就只改那一點；播放頭離開那一點超過 2 格就取消選取。拖右下角等比改框的大小（1～4 倍）。「＋ Keyframe」在播放頭加一個路徑點（2 格內已有點就選它）。Done／Esc 離開。
- **Zoom 頁籤**：清單（開關、時間、倍率、調整、刪除）。
- 預覽與輸出：`framePlan` 的影像圖層帶裁切範圍，`GlCompositor` 改貼圖座標（D24，預覽與匯出同一份）；預覽的下層狀態含放大範圍，讀下層畫面的 3D 場景會跟著重畫。和 3D 場景的順序：局部放大在片段上先做，3D 場景拿放大後的畫面當貼圖。
- 目前只支援 V1 的片段（子母畫面的框要另外換算座標）；放大條不吸附剪接點（原專案有，之後要再加）。
- AI 導演多一個工具 `proposeZoom(start, end, region)`：Muse Spark 看到畫面上正在操作的地方（游標、正在打字的區域）就提議放大（11/2 和 AI 導演一起做）。
- 實作紀錄：10/28 上午先做了片段關鍵幀版（commit 478b1f6、a95f398），同日依開發者要求改成上述區段版（D38）。
- 驗收：Vitest（照搬原專案的數學測試、建立／平移／修邊、framePlan 裁切）；e2e（選範圍建立、縮成 4 倍拖到紅色色條、範圍外原畫面、加路徑點只移動那一點、匯出也放大、Delete 與復原）。

### 5.20 片段變速、定格與其他特效（D20）

- **片段變速（P1-6）**：屬性面板設 0.25～4 倍；時間軸上片段長度跟著變。畫面：合成器依變速換算每格的素材時間；聲音保持音高：預覽用 `<audio>.playbackRate`＋`preservesPitch`（§5.13），匯出用 TS 的 WSOLA（§5.4）。
  - **實作（10/28）**：`setClipSpeed`（`src/core/speed.ts`）：倍數夾在 0.25～4、取到小數兩位，片段至少 0.1 秒；連動片段（其他軌道上同一支素材、同起點、同素材範圍，通常是 A1 對白）一起變速，選 V1 或 A1 結果一樣；V1 片段變長變短時 V1 重排，其他未鎖定軌道上「在它原本結束點之後開始」的片段、特效、時間軸定位點平移同樣距離，跨在中間的（配樂、蓋過接點的特效）不剪不動（開發者 2026-10-28 選定）；淡入淡出各自不超過新長度；局部放大與詞用素材時間記，不必動。Inspector 選到片段時顯示片段屬性（0.25～4 倍按鈕＋自訂），`setSpeed` 編輯。預覽的 `playbackRate` 夾在 0.0625～16（瀏覽器上限；4 倍片段再按 L 快轉時會碰到）。
  - 驗收：Vitest 6（長度、連動、平移規則、鎖定軌、夾倍數、復原）；e2e 2 倍與 0.5 倍：時間軸長度、A1 一起變、匯出長度正確、聲音上升過零每秒約 440 次（WSOLA 保持音高）。預覽的 `preservesPitch` 在 Playwright 量不到音高，沒有自動驗。
  - 限制：Ctrl+B 切開只切一個片段，切開後的 V1 片段沒有完全相同的 A1 夥伴，變速時聲音不會跟著變（既有行為）；4 倍片段跨過 5 分鐘混音段時，那段要讀 20 分鐘的來源聲音（約 460 MB），很少見，先不處理。
- 11/2 已做：定格（Shift+F，或在 Inspector 按 Freeze 2 s，定格期間沒有聲音）；色彩調整（Effects → Color，預設整條，有選範圍就只調那段，預覽與匯出共用同一個 shader）；2D 圖層的圖片填色（Inspector → Image fill）。
- **定格（P2）**：在播放頭把畫面凍結 N 秒（`Clip.freeze`，合成器在那段時間一直畫同一格；聲音可選靜音或繼續），常用在講解時停在某個畫面。
- **轉場（P2）**：見 §5.9。
- **色彩調整（P3）**：片段層級的亮度、對比、飽和度、色溫；合成器的 shader，預覽與輸出共用。
- 其他畫面特效（強調框、箭頭、大標、字卡、粒子…）一律由 2D／3D 插件與 Vibe特效提供，不另外寫成內建功能。

### 5.21 網頁版與效能（P0，D21）

**效能原則（只有 CPU）**

- **預覽一律用低解析代理檔**：每支影片匯入時產生 540p（寬 960）的代理檔（不透明 H.264、帶透明 VP9 透明 WebM，Q5），關鍵幀間隔短（1 秒），預覽、拖曳、逐格都用它；CPU 解碼 1080p 太吃力。匯出才用原檔（或中間檔）。
- **匯出用硬體編碼**：WebCodecs `VideoEncoder` 優先硬體（Intel 內顯走 Media Foundation／QSV），沒有就軟體編碼（§5.4）。
- **代理檔與中間檔走原生（Windows 版）**：ffmpeg 多執行緒（`-threads` 依核心數），有 QSV 就用（授權見 §3）；聲音分離用 onnxruntime 原生 CPU 多執行緒，有 DirectML 再用。
- **AI 分析都在雲端模型**（ASR、AI 導演、SAM、Vibe），不吃本機。
- **重工作排隊**：代理檔、聲音分離、匯出一次只跑一個，避免互搶 CPU；進度條顯示排隊順序。縮圖序列（D39）也走同一個規則：素材準備、匯出、轉錄進行中（`core/busy.ts` 登記）或正在播放時，背景排程停下來；桌面版和代理檔共用 Rust 的重工作鎖。
- **3D**：WebGL 用內顯即可。偵測到沒有硬體加速（軟體算繪）時，3D 預覽自動降到 540p、匯出的 3D 區段用 720p 算再放大，並提示使用者。
- **10/27 實測**（Core Ultra 5 125H＋Arc 內顯，`spikes/export-bench/RESULT.md`）：11.3 分鐘 1080p 多軌片，統一合成器在 WebView2 約 232 秒（2.9 倍即時）、含 60 秒 3D 約 255 秒；3D 區段每格只多 4～7 ms。60 分鐘的片估計約 20 分鐘匯出完。

**網頁版**

| 項目 | 網頁版 | Windows 版 |
| --- | --- | --- |
| 執行環境 | Chrome／Edge（WebCodecs、File System Access、OPFS） | Tauri 2（WebView2） |
| 匯入格式 | 只吃 H.264／AAC 的 MP4、MOV（瀏覽器能解的）；其他格式提示用 Windows 版 | 任何 ffmpeg 讀得到的格式；WebCodecs 解不了的另轉中間檔（Q5） |
| 代理檔 | 用 WebCodecs 轉 540p（較慢）；短片可以直接用原檔 | ffmpeg |
| 匯出 | 兩版相同（D24）：WebGL 合成器＋WebCodecs 編碼（H.264；有 AAC 編碼器用 AAC，沒有用 Opus）＋mediabunny 封裝 MP4 | 同左；寫檔走 Tauri |
| 聲音分離 | 不做（D28），提示改用 Windows 版 | onnxruntime 原生 |
| 麥克風錄音 | `getUserMedia` | 同左 |
| 建議片長 | ≤ 10 分鐘 | 不限 |

- 部署（2026-10-27 開發者決定）：網頁版是建置出來的靜態檔案，放 Zeabur 專案 `wordblade` 的獨立服務 `wordblade-web`（神奇網路主機，nginx 設 COOP／COEP 與單頁應用的回退），網址 `https://wordblade.zeabur.app`；部署 `pwsh scripts/web-zeabur.ps1`（`deploy/web/` 放 Dockerfile 與 nginx 設定）。閘道已放行這個網域的 CORS（§6）。
- 範例專案的影片**不要**放在家用節點上：原專案實測神奇網路主機經閘道傳媒體約 470 KB/s、HTTP/3 會卡住（§11）。11/3 打包時另外找地方放（例如 GitHub Releases 或物件儲存），再決定。
- WebCodecs、OffscreenCanvas、File System Access 需要的安全標頭（COOP／COEP，用來開 SharedArrayBuffer 與 WASM 多執行緒）一起設好。Windows 版也一樣：10/27 實測 Tauri 預設 `crossOriginIsolated` 是 false，要在 Tauri 設定加上這兩個標頭（JASSUB 的多執行緒要用）。**10/27 已設**：`tauri.conf.json` 的 `app.security.headers`、Vite dev／preview 的 `headers`（開發與 e2e 才和正式環境一致）；實測 WebView2 與 Chromium 都是 `crossOriginIsolated = true`、有 `SharedArrayBuffer`，素材（asset 協定，CORS 模式）、畫布、Web Audio、回報 POST 都照常。
- 伺服器沒有 GPU，所以 MusicGen、Demucs 這類要 GPU 的模型不能放 Zeabur，只能用 Modal／Baseten（合作夥伴額度）或不做。

### 5.22 範例專案、一鍵試用（P0，D22）

- 內容：一支 2 分鐘的英文片段（作者自己錄，含一個假 API 金鑰），預先算好並存在專案檔裡：逐字稿與字幕、SAM 遮罩、AI 導演建議清單、2 個 Vibe 2D 特效、1 個 3D 場景（螢幕在桌上＋吉祥物）、局部放大、逐字高亮字幕、配樂。
- **範例專案本身是 P0，但內容跟著實際做完的功能走**：P1 項目（SAM 遮罩、AI 導演、局部放大、逐字高亮、配樂…）在 11/1 檢查點被砍的話，範例專案就不放那一項；P0 的部分（剪輯、字幕、2D／3D 特效、3D 場景、匯出）一定要有。
- 網頁版首頁一個「Try the sample project」按鈕：從靜態網站載入（不用權杖、不呼叫 AI），所有功能可以預覽、播放、匯出；要重新跑 AI 時才需要權杖。
- Windows 版：說明頁有同一個按鈕，第一次點時下載範例專案。
- README 與提交表都放網頁版網址與「Try the sample project」的說明。評審用的邀請權杖**只放在提交表**，README 寫「Judge token: see the submission form」（repo 公開後 README 誰都看得到）。
- 時程（D30）：10/31 錄素材，同一支片先拿來做 ASR 英文實測與贅詞實測；之後各功能做好就順手在這支片上跑一次；11/3 只做打包（預先算好的結果存進專案檔、上傳；影片放哪見 §5.21）。

**實作（10/29，計畫 `docs/plan-10-29-sample.md`）**

- 和上面的出入（開發者 2026-10-29 決定）：素材改用腳本合成的 `samples/demo-2min.mp4`（螢幕畫面＋TTS 旁白，含假金鑰；作者不自己錄，D30 取消）；Windows 版**打包進安裝檔**（不另外下載）；片頭封面用 Muse Image 生成；背景配樂用 AI 配樂。
- 內容由 `e2e/sample-build.spec.ts` 實際跑 AI 產生（可重跑，約 5 分鐘）：Muse ASR 逐字稿、AI 導演 8 條建議（採用遮假金鑰、剪重講）、去贅詞、逐字高亮、Vibe 2D ×2、桌上螢幕＋吉祥物、AI 配樂、翻頁式片頭、發佈包與縮圖；每一步的結果寫在 `public/sample/BUILD.md`。
- 放在 `public/sample/`（project.json＋media/＋thumbnail.png，約 12 MB，進版控）：網頁版從靜態網站讀，標題列「Try the sample project」或網址 `?sample=1`；Windows 版讀安裝資料夾的 `sample\`（開發時是 repo 的 `public\sample\`）。示範狀態：沒編輯前不自動存。
- 驗證：e2e `sample.spec.ts` 擋掉所有對外連線仍能開啟並匯出；安裝檔驗證時自我檢查讀到全部 16 個素材。


### 5.23 一鍵片頭（P1-12，D34）

開發者 2026-10-27 要求列入。調查與範本設計見 `docs/research/intro-styles.md`（以下簡稱「調查」）。

**要做的事**

- 輸入：素材庫裡的多張封面圖、標題、副標（選填）、icon（選填）、音樂（使用者自己的、內建範本生成、或不要）、風格與參數。
- 一鍵產生片頭並插在時間軸開頭（漣漪插入，沿用素材拖到 V1 的插入規則，§5.13）；整個片頭是一次編輯，Ctrl+Z 一次復原；改參數可以重算（同一個亂數種子結果相同）。
- 第一個範本「**翻頁式片頭**」：多張圖越翻越快（每張停留時間依比例遞減）、高潮一次閃光、標題閃入（字內輪流透出封面）＋icon 彈入；每翻一頁一聲翻頁音效、高潮前上升音（riser）、揭曉時重擊（impact）；配樂的重拍對準揭曉那一刻。節奏、音效合成、對拍參數沿用開發者 2026-10-18 做的片頭（`D:\GitHub\yt任務\片頭片尾\brand-v2\`，HyperFrames＋GSAP，調查 §1、§3.4），程式改寫成 three.js 插件與宣告式音效。介面與文件叫「翻頁式片頭」，不用 Marvel 的名稱與任何真實品牌的示範圖（商標）。
- 之後的範本（調查 §2、§5 的建議順序）：節拍切圖幻燈片＋Ken Burns（同一範本、參數切快慢）、格狀拼貼 → 標題；再來是 Logo reveal、Glitch、3D 卡片飛入。其餘風格（kinetic typography、漏光、分割畫面、鏡頭穿越、YouTuber 頻道片頭）列在調查 §2 備查。

**設計（調查 §3）**

- 範本是 TS 純函式（Vitest 可測），不是插件：輸入＋音樂分析 → 時間點清單（cue：翻頁、閃光、揭曉、標題進場…）→ 由同一份 cue 表產生特效區段（插件只依時間與參數畫）、A3 音效片段（每個 cue 一段，指向同一個 `Synth` 算好的 WAV，音量依強度）、A2 配樂片段（`srcIn` 讓重拍對準揭曉）。畫面與聲音出自同一份清單，一定同步。
- 對拍：使用者的音樂用 BPM 偵測（`web-audio-beat-detector`，MIT）＋移植 brand-v2 的重拍評分（找「前面安靜、後面變大聲」的拍點），給前 3 名候選試聽；信心低時退回固定節奏並提示。沒有音樂時用內建配樂範本（§5.15 的配樂 spec，固定 BPM，重拍落在小節頭）。不用 `essentia.js`（AGPL）。
- 拍點以秒存，換格照合成器既有的 `Math.round` 規則，不逐拍累加。

**待開發者決定（調查 §4）**

1. 插件拿到多張圖的方式：建議主程式把 `Effect.params.imageIds` 解碼成 `ImageBitmap`（縮到寬 ≤ 1600）轉移進沙盒，放 `env.images`。
2. 音效擺位：建議產生多個 A3 片段共用一個 `Synth` 的 WAV（使用者可以在時間軸上微調某一聲）；另一案是 `Effect` 加 `soundCues`。
3. 片頭期間 V1 的佔位：建議加內建純色（黑）素材當 V1 片段，畫面由插件全畫面畫。
4. 封面的雙色調：建議在插件 shader 裡做，不產生檔案。
5. 音效 spec 加「隨機振幅調變（rate、depth）」，才做得出翻頁的紙張顆粒感；不加就接受近似版。
6. Worker 裡載入字型（`FontFace`／`self.fonts`）要在 WebView2 實測。
7. 排程（開發者 2026-10-27 授權自行安排）：11/3 上午（翻頁式需要 10/29～10/30 的沙盒與 3D 插件；成品也當宣傳影片的開場）；11/1 檢查點可以再調。

**實作（10/29，計畫 `docs/plan-10-28-intro.md`）**

- 待決定 1～5 照建議（開發者 2026-10-28）：3D 沙盒加 `images` 協定，`params.imageIds` 由主程式解碼（寬 ≤ 1280）後放進 `env.images`；每個音效 cue 一個 A3 片段，共用同一支 WAV；V1 佔位是產生的黑色 PNG（`intro-black.png`）；雙色調在 shader 做；音效 spec 加 `am {rate, depth}`。
- 程式：`intro/flip.ts`（cue 表）→ `intro/insert.ts`（`flipEffect`、`insertIntro` 編輯，一次復原）→ `three/builtins/flipIntro.js`（插件）；聲音在 `intro/sounds.ts`；介面在 Effects › Intro。
- 和上面的出入：
  - 有內建配樂時揭曉在 4.0 秒、片頭 8 秒（120 BPM 第 3 小節）；不要配樂時揭曉 3.2 秒、片頭 6.2 秒。
  - 標題用系統字（Worker 裡的 `sans-serif` 粗體），沒有載 FontFace（第 6 項沒做）。
  - 使用者自己的音樂與 BPM／重拍偵測沒做（I6，建議砍）。
  - 「改參數重算」目前是再按一次 Generate，會在開頭**再插一段**，舊的往後推；要換掉得先 Ctrl+Z。
  - 內建配樂用 `renderMusic` 算，它會把尾巴疊回開頭（為了循環），片頭第一拍可能不是完全安靜。
- 驗證：Vitest（cue 表、插入、音效 spec 與實際算圖）；e2e `intro.spec.ts`（預覽：翻頁段雙色調、揭曉後藍方塊白字、A3 有 18 個片段、Ctrl+Z；匯出成 MP4 後用 ffmpeg 檢查畫面與音量）。WebView2 只驗過 PNG 佔位的匯入，片頭本身還沒在 Windows 版算過。

## 6. 閘道

- **技術**：Java 21、Spring Boot 4.1、Spring AI 2.0、PostgreSQL（Flyway）；部署在 Zeabur。報名稿寫的就是這個架構（D10）。
- **部署（10/27）**：Zeabur 專案 `wordblade`，在 Wonder Mesh 自架主機（`server-69eeeb93f5343e60f36375c2`）上，服務 `wordblade-gateway`＋`postgresql`；公開網址 `https://wordblade-api.zeabur.app`（自架主機在 CGNAT 後，網域經 GraphQL `attachWonderMeshUpstream` 綁到東京閘道）。重跑 `pwsh scripts/gateway-zeabur.ps1`；新增邀請權杖 `-NewToken <名稱>`（原文只顯示一次，資料庫只存 SHA-256）。網域 502 但服務 RUNNING 時，先查 wonder-mesh-gateway 專案的 tailscale-sidecar。
- **AI 任務路由**（Spring AI `ChatClient`，OpenAI 相容；AI 導演統籌與 Vibe特效用 Muse Wonder、其他用 Muse Spark 1.3，D12、D31）：

| 路由 | 輸入 | 輸出（結構化，Java record） | 用到的 Spring AI 功能 |
| --- | --- | --- | --- |
| `POST /v1/ai/proofread` | 一批逐字稿、選用講稿 | 疑似聽錯的詞、重複語句 | `.entity()` 結構化輸出 |
| `POST /v1/ai/vibe` | 種類（2d／3d）、描述、選用截圖與參考圖、畫面條件、底稿範本；續修時帶對話 id 與錯誤 | 插件程式＋參數定義，或拒答代碼 | Muse Wonder（D31）；結構化輸出、`Media`、`ChatMemory` |
| `POST /v1/ai/plane3d` | 描述、選用截圖、區段長度、目前場景與鏡頭關鍵幀、定位點 | 鏡頭關鍵幀與場景設定（不是程式碼），或拒答代碼 | 結構化輸出、`Media`、驗證不過回饋重問 |
| `POST /v1/ai/mask-terms` | 任何語言的遮罩描述 | 1～4 個英文名詞片語 | 結構化輸出 |
| `POST /v1/ai/director` | 縮小的分段影片、逐字稿 | 建議清單（非同步工作，SSE 回進度） | Muse Spark 1.3 平行逐段分析＋Muse Wonder 工具呼叫（`@Tool`）統籌 |
| `POST /v1/ai/image` | `purpose`（texture／background／thumbnail）＋描述，縮圖另帶底圖 | 圖片（材質由前端再做無縫化與法線貼圖） | Muse Image（`/v1/images/generations`、`/edits`） |
| `POST /v1/ai/sound` | 音效描述、長度；改版時帶前一版 spec | 音效 spec（宣告式 JSON，閘道用 JSON Schema 驗證；桌面算成 WAV），或拒答代碼 | 結構化輸出 |
| `POST /v1/ai/music` | 配樂描述（風格、速度、情緒）、長度；改版時帶前一版 spec | 可循環的配樂 spec（宣告式 JSON，同上驗證），或拒答代碼 | 結構化輸出 |
| `POST /v1/ai/publish` | 成片逐字稿（成片時間）、片長 | 標題選項、說明、章節、標籤 | 結構化輸出 |

  結構化輸出（10/27 實測）：Meta 支援 `json_schema`（strict）。Spring AI 要加 `AdvisorParams.ENABLE_NATIVE_STRUCTURED_OUTPUT` 才會真的送 `response_format`（否則只把 schema 寫進提示詞）。Spring AI 2.0 的 OpenAI 模組底層是 openai-java SDK，`base-url` 寫 `https://api.meta.ai/v1`（含 `/v1`）。看影片的呼叫不走 `ChatClient`，見 §5.11。

- **轉送路由**（`RestClient`，Spring AI 沒有對應的模型介面）：

| 路由 | 上游 | 計量 |
| --- | --- | --- |
| `POST /v1/asr` | Muse Voice Transcribe（10/27 已實作，§5.2；上游用 DELTA 串流，回 transcript、turns、deltas） | 音訊秒數（WAV 長度） |
| `POST /v1/sam` | SAM 3.1（上傳、SSE 轉送、刪檔） | 影片格數 |
| `POST /v1/tts` | Fish Audio | 生成語音秒數 |
| `POST /v1/music` | Meta MusicGen（Modal／Baseten 上的端點，P2） | 生成音樂秒數 |
| `GET /v1/me` | — | 今日用量（自己與全站） |

  每次呼叫都記錄用量：AI 任務記輸入＋輸出 tokens（AI 導演另記次數與每格 token），Muse Image 記張數，轉送路由記上表的計量。

- **驗證**：`Authorization: Bearer <邀請權杖>`；權杖只存 SHA-256；可停用。
- **額度（D29）**：黑客松期間**不設每人與全站的用量上限**，以 demo 能順利操作為優先；只記錄用量，`GET /v1/me` 查得到。單次請求的限制照設（見「安全」），那是防濫用。
- **CORS**：開放網頁版的網域（D21）與 Windows 版 WebView2 的 origin `http://tauri.localhost`（WebView2 裡的 `fetch` 是瀏覽器請求，照樣帶 Origin、照樣受 CORS 管）。10/27 實測（`spikes/tauri-env/`）：GET、POST 送出的 Origin 都是 `http://tauri.localhost`，帶 `Authorization` 時先發 OPTIONS 預檢；放行它即可，不需要 `tauri-plugin-http`。開發時另放行 `http://localhost:1420`。
- **費用**：Meta 的黑客松額度（US$150）用完會開始扣作者的卡。不設上限，所以每天收工前看一次 `GET /v1/me` 的全站用量；接近額度時手動停用評審以外的權杖（§11）。
- **安全**：金鑰只在閘道環境變數；log 不記內容、只記用量；不回傳供應商錯誤內容；請求大小與逾時上限。

## 7. 測試與驗收

| 層 | 工具 | 重點 |
| --- | --- | --- |
| TS 核心 | Vitest | 時間軸映射、改字即剪、漣漪跨軌規則（§4）、字幕斷句與 `CaptionBreak`、手改字幕重新分詞、詞級時間重建（用錄好的 ASR 回應當夾具）、每格圖層計算 |
| Rust 指令 | cargo test | ffprobe 解析、ffmpeg 進度解析、sidecar 路徑 |
| 介面 | Playwright（React 跑在瀏覽器、Rust 指令用假的） | 熱鍵、改字即剪、遮罩面板、匯出流程 |
| 輸出 | Playwright 在 Chrome 真的跑匯出 | 剪後長度、字幕時間、遮罩位置；同一格的預覽畫面與匯出畫面抽格比對（同一個合成器，差異應只來自編碼） |
| 剪輯功能 | Vitest | 去贅詞清單與剪法、局部放大的關鍵幀內插、變速後的時間映射、WSOLA 長度與音高、配樂壓低的增益曲線、卡拉 OK 的 ASS 標籤、宣告式音效 spec 的解讀 |
| 沙盒 | Vitest＋Playwright | 插件連不了網路（含 WebRTC）、逾時會被終止、`Math.random`／`Date.now` 被固定、同一格兩次算出一樣、跳時間後結果和從頭播一致 |
| 聲音分離 | cargo test | STFT／iSTFT 來回誤差、分段接合沒有接縫（用短音檔夾具） |
| 閘道 | JUnit＋Testcontainers | 權杖、用量紀錄、CORS、所有 AI 任務與轉送路由的驗證與錯誤對應（假上游）；音效與配樂 spec 的 JSON Schema 驗證；AI 導演用假模型跑完整流程 |
| 端到端 | 自己的錄課影片 | §1 的四個成功標準 |

## 8. 時程（台灣時間）

| 日期 | 內容 |
| --- | --- |
| 10/27 | 專案骨架：Tauri 2＋React＋Vite（同一份程式出網頁版與 Windows 版，`Engine` 介面）、ffmpeg sidecar、素材庫與 540p 代理檔；閘道骨架（本機跑）；**只做會改變架構的實測**：①沒有 same-origin 的 iframe 裡建 Worker 與 WebGL2、§5.7 的 CSP；②D24 判準的匯出量測（§5.21 的三項）；③Spring AI 能不能送影片 `Media` 與 `json_schema` 結構化輸出，順便量每格影片的 token 數；④ffmpeg 版本與 H.264 編碼器；⑤WebView2 送出的 Origin 與閘道 CORS；⑥麥克風錄音 |
| 10/28 | 安裝檔打包跑通一次、網頁版與閘道部署到 Zeabur（神奇網路主機）；多軌時間軸模型、拖曳、修邊、漣漪剪輯（含 §4 跨軌規則）、熱鍵、復原；合成器預覽（D24）與 Web Audio 混音；素材庫與匯入、代理檔——**以上 10/27 都已提前完成**（`docs/plan-10-27.md`），麥克風 `PermissionRequested`、Tauri 的 COOP／COEP、尺規拖曳也在 10/27 做完，10/28 提早開始 10/29 的沙盒 |
| 10/29 | **核心①**：沙盒、2D 插件與範本、預覽；Vibe特效 2D（閘道 `/v1/ai/vibe`、錯誤回饋重寫）——**10/27 已提前完成**（`docs/plan-10-29.md`；閘道 10/27 重新部署）。空出的時間：10/28 起提前做核心②（3D），再補 2D 範本的音效擺位（§5.15）與粒子／計數器範本 |
| 10/30 | **核心②**：3D 插件（three.js）、3D 範本（螢幕在桌上、吉祥物）、env 互動（當格畫面、定位點）；Vibe特效 3D；3D 場景與「用說的」——10/27 晚上起提前開始（`docs/plan-10-30.md`） |
| 10/31 | **錄 2 分鐘英文範例短片**（D30）；~~MP4 匯出~~、~~Muse ASR~~——**10/27 已提前完成**（`docs/plan-10-31.md`；§5.4、§5.2：WebView2 1080p 30 秒約 6～7 秒匯出；詞級時間改用 DELTA 錨點，句首平均誤差 0.04～0.07 秒）。10/31 剩：用範例短片做英文真人錄音的逐字驗收（≤ 0.15 秒）、變速片段的預覽與匯出聽感比較 |
| 11/1 | **逐字稿面板、改字即剪、字幕燒錄、逐字高亮、一鍵去贅詞＋清除無聲片段、局部放大——10/28 已提前完成**（`docs/plan-11-01.md`）；原列：逐字稿面板、改字即剪、字幕與 SRT、逐字高亮字幕、一鍵去贅詞＋清除無聲片段（P1-13，共用確認清單）、局部放大；**檢查點**：依 §2 決定 P1 後段砍到哪 |
| 11/2 | **片段變速 10/28 已提前完成**（`docs/plan-11-02.md`）；AI 導演（Spark 逐段＋Wonder 統籌，含 proposeZoom）；SAM 遮罩；片段變速 |
| 11/3 | **範例專案打包**（§5.22，素材 10/31 已錄）；上午先做翻頁式片頭（P1-12，§5.23；要 10/30 的 3D 插件，也當宣傳影片的開場）；照 P1 順序做到哪算哪：發佈包、AI 音效、重配錄音卡拉 OK、聲音分離、AI 音樂、Muse Image 材質圖（P1-14）；修 bug；正式版安裝檔；**晚上錄宣傳影片素材** |
| 11/4 | **停止加功能**：用 WordBlade 剪自己的宣傳影片、寫 README、repo 公開；台灣 11/4 晚上提交 |
| 11/5 10:00 前 | 最晚提交時間 |

時程很緊：每天收工前檢查進度，落後超過半天就把當天最後一項往後移；11/1 檢查點照 §2 的取捨順序砍 P1 後段；P2、P3 不排進時程。Demucs 與三軌拆分的實測移到做聲音分離時再做。

## 9. 比賽策略

**評審實際怎麼看（推論）**：名額 2 萬人、評審只有 11/4～11/8 四天，多半先看 demo 影片與簡介，前 30～60 秒決定要不要細看。所以 Demo（25%）也決定了其他 75% 有沒有機會被認真看；每個賽道只取前 5 名，要有別人做不出來的亮點。

| 評分 | 怎麼拿分 | 做法 |
| --- | --- | --- |
| Impact 30% | 真實問題、誰受益、會不會有人用 | 用自己的課示範原始錄影 → 可上架影片，量出「原本幾小時、現在幾分鐘」 |
| Meta 工具 25% | 超出基本串接、發掘意外能力 | AI 導演（Wonder 統籌＋Spark 看影片）串起 SAM、Vibe（Wonder 寫程式）、3D；共用到 5 個 Meta 模型 |
| Demo 25% | 能動、現場撐得住、影片品質 | demo 用 WordBlade 剪；英文旁白；開場 30 秒放最炫的畫面；附安裝檔，評審用的邀請權杖放提交表 |
| 技術 20% | 工程扎實 | 沙盒執行 AI 寫的程式、詞級時間重建、預覽與輸出一致、Spring AI 結構化輸出與工具呼叫、測試；README 附架構圖 |

**Demo 影片：WordBlade 剪自己的宣傳影片（約 3 分鐘，開發者 2026-10-26 定）**

概念：demo 就是一支 WordBlade 的宣傳影片，而這支宣傳影片從頭到尾是用 WordBlade 剪的；影片裡同時看得到「剪輯的過程」和「剪出來的成品」。這樣一支影片同時證明三件事：功能真的能用（Demo）、解決的是創作者的真實問題（Impact）、每一步都用了 Meta 模型（Meta 工具）。

**素材**（11/3 晚上錄）

- 開發者對著鏡頭用英文講一段 5～8 分鐘的介紹（不必一次講好：重講、口誤、停頓正好給 AI 導演剪）。
- 背景故意出現一個假的 API 金鑰（便利貼或螢幕上），給 AI 導演和 SAM 找。
- WordBlade 的螢幕錄影：操作 AI 導演、Vibe特效、3D、字幕、匯出的畫面（各錄成一支，放進素材庫）。
- 配樂與音效（免版稅，README 註明來源）。
- 剪法：V1 放真人介紹與螢幕錄影，V2 放子母畫面，A2 配樂、A3 音效；架構仿之前的 YT 宣傳影片（木紋桌上的螢幕、吉祥物走過去按按鈕、鏡頭推近、大標與步驟說明）：
  - 桌上的螢幕用 WordBlade 的 3D 場景範本做，鏡頭用「用說的」。
  - 吉祥物用 Vibe特效生成的 3D 插件，走到定位點（在畫面上點的按鈕位置）做動作。
  - 大標與步驟說明用 2D 動畫插件。
  - 備案（D14）：3D 插件做不到想要的品質時，吉祥物改在外部用 three.js 做成透明影片，放到疊加軌。

**成片結構**

1. 0:00～0:20：成品的精華，以 Vibe特效為主（D19）——一句話變出的 2D 動畫、一句話生成的 3D 吉祥物走到按鈕旁邊、影片飛進桌上的螢幕；再閃過逐字高亮字幕與被自動遮掉的 API 金鑰；打上一行字「This video was edited by WordBlade.」
2. 0:20～0:50：問題——開發者講「錄一段影片，整理成能發的版本要好幾個小時」。
3. 0:50～2:20：製作過程（螢幕錄影加速播放）：匯入這支原始錄影 → Muse ASR 產生字幕 → AI 導演列出建議（重講、口誤、API 金鑰、適合加特效的地方）→ 一鍵採用（含去贅詞、局部放大）→ 用一句話加 Vibe特效（2D／3D）與 3D 運鏡 → 逐字高亮字幕 → 發佈包（標題、章節、Muse Image 縮圖）→ 匯出。每一步在角落標出用了哪個 Meta 模型。
4. 2:20～2:50：原始錄影與成品左右對照；數字：「原始 X 分鐘 → 成品 Y 分鐘，剪輯花了 Z 分鐘」。
5. 2:50～3:00：架構圖一閃、GitHub 連結、Muse 模型清單。

**注意**：要在 11/3 晚上前把 AI 導演、Vibe特效、3D、字幕、匯出都做到能用，素材才錄得成；11/4 只剪片、不改功能。來不及的功能就不入鏡，不要放假的畫面。

**其他**

- 加碼獎（社群票選、最受歡迎，最多 5 萬美元）：開發期間每天在 X 貼一段 10 秒短片（Vibe特效、3D、AI 導演），標記 Meta。
- Discord office hours：問 Muse ASR 詞級時間戳、影片輸入上限，順便讓 Meta 團隊認識這個作品。
- 提早交件：目標台灣 11/4 晚上，不拖到 11/5 10:00。

## 10. 提交清單

- [ ] repo 公開，README（英文）：功能、使用的 Meta 模型與用法、架構圖、怎麼安裝與執行、黑客松期間做了什麼。
- [ ] Windows 安裝檔（GitHub Releases）。
- [ ] Demo 影片：WordBlade 剪自己的宣傳影片（§9 的結構），上傳 YouTube（不公開或公開）。
- [ ] README 的「Meta models used」：每個模型用在哪個功能（Muse Voice Transcribe、Muse Spark 1.3、Muse Wonder、SAM 3.1、Muse Image；有做的話加 MusicGen、Demucs）。
- [ ] README 的「Built during the hackathon」：說明這個 repo 從 10/26 開始寫，以及參考了作者先前做影片工具的經驗。
- [ ] 第三方授權清單（§3）。
- [ ] 網頁版網址＋「Try the sample project」（評審不用安裝、不用權杖）。
- [ ] 評審試用的邀請權杖（想跑 AI 功能時用）：**只填在提交表**，README 寫「Judge token: see the submission form」。
- [ ] 填 Cerebral Valley 提交表（`https://cerebralvalley.ai/e/meta-ai-developer-hackathon/hackathon/submit`）。

## 11. 風險

| 風險 | 對策 |
| --- | --- |
| Tauri＋React 從零起步，前兩天可能卡在環境 | 10/27 優先把骨架、sidecar、打包跑通；卡超過半天就縮小 P1 範圍 |
| 詞級時間重建的精度不夠剪輯 | 先用夾具調參；不夠就讓剪輯點吸附到靜音邊界，而不是詞的估計時間 |
| SAM 影片追蹤慢或貴 | 每秒 10 格、寬 ≤ 1280；只送使用者選的範圍；每天看用量（D29 不設上限） |
| WebView2 無法播 HEVC 等格式 | 匯入時偵測，先轉 H.264 代理檔 |
| 範圍比報名時大很多（加了五種特效） | 嚴守 P0 → P1 → P2；P0 的順序照 D19：剪輯骨架 → Vibe特效（2D＋3D）與 3D 場景 → 匯出 → 字幕；P1 照 §2 的砍除順序（SAM 遮罩是 P1-5，必要時只做框狀）；範例專案跟著縮減（§5.22）；P2 整項不做 |
| Muse Wonder 是預覽版（可能不穩、只有 Standard 模式、較貴） | 第一天實測；不穩就 AI 導演全部由 Muse Spark 1.3 做（Wonder 只做最後整理），Vibe特效改用 Spark（D31，模型 ID 走設定） |
| 影片輸入太大、太慢或太貴 | 480p、每秒 2 格、無聲、2 分鐘一段；必要時改送關鍵格圖片 |
| WebAudio 生成的配樂聽起來太陽春 | 範本當底稿、限定科技類背景配樂的風格；時間夠就做 MusicGen（P2） |
| MusicGen 權重非商用 | 只在黑客松展示；README 註明授權；商品化前換掉 |
| 聲音分離在 CPU 上很慢（約 2.4 倍片長，只跑人聲模型） | DirectML 優先；背景執行可取消；只分離使用者選的素材；結果快取 |
| 多軌合成預覽不同步、切換閃黑 | 主時鐘＋雙 `<video>` 交替；預覽偏差超過 1 格就校正；最壞情況預覽降解析度，輸出逐格解碼不受影響 |
| 不設額度（D29），Meta 的 US$150 額度可能被用完、開始扣作者的卡 | 每天收工前看 `GET /v1/me` 的全站用量；接近額度時手動停用評審以外的權杖；必要時再加上限 |
| 統一合成器匯出比 ffmpeg 慢（沒有 3D 時 1.7 倍） | 已接受（D24 定案）；還沒做跨格管線化，有加速空間。沒有硬體編碼的電腦用軟體編碼，匯出會更慢 |
| 匯出時保持音高的變速（WSOLA）聽起來和預覽不同 | 10/31 實測；差太多就 Windows 版改由 ffmpeg `atempo` 只處理音訊（量很小） |
| 多軌時間軸讓前三天的工作量變大 | 10/27～10/29 只做多軌的基本功（擺放、修邊、疊加、混音），進階操作（群組、關鍵幀）一律不做 |
| AI 寫的程式跑出問題（無窮迴圈、偷連網） | 沙盒 iframe＋Worker、CSP 擋網路、刪掉 WebRTC、每格限時；逾時直接終止 Worker。音效與配樂改成宣告式 JSON，不執行程式（D27） |
| 特效輸出很慢或吃記憶體 | 只算有插件的區段；畫格以 `ImageBitmap` 轉移、不複製也不存檔；軟體算繪時 3D 圖層用 720p |
| 模型寫的 3D 場景品質不穩（比例怪、動作僵） | 預設拿範本當底稿修改；Muse Image 概念圖當參考；可匯入現成 glTF 模型 |
| 功能數量遠超 9 天能做的量 | 核心（Vibe 2D／3D）排在第 3、4 天就做；11/1 檢查點照取捨順序砍 P1 後段 |
| 只有 CPU，預覽卡頓、匯出慢 | 預覽一律 540p 代理檔；匯出用 WebCodecs 硬體編碼（Intel 內顯 QSV）；重工作排隊；10/27 量測 |
| 長片匯出吃光記憶體（兩版共用同一條匯出管線） | 聲音每 5 分鐘一段離線混音、影像逐格解碼與編碼、mediabunny 串流寫檔（§5.4）；10/31 用 60 分鐘素材跑一次看記憶體；網頁版仍建議 ≤ 10 分鐘 |
| Zeabur 邊緣的 HTTP/3 讓長連線間歇卡住（原專案 2026-09-24：同時 10 個媒體串流在 h3 下約 1／5 卡死，h2 正常） | 範例影片不放家用節點（§5.21）；閘道的 SSE 與上傳設「多久沒進度就中止重試」 |
| 兩個版本讓工作量變多 | 平台相關的只收在 `Engine` 介面，其他程式只寫一份；網頁版功能缺的直接提示改用 Windows 版 |
| ASR 不保留贅詞 | 改從「有聲音卻沒有文字」的短片段找，讓使用者試聽確認 |
| 麥克風錄音被擋（防毒、權限） | 10/27 先確認；備案是 Rust 層錄音，或改用 AI 重生語音 |
| ffmpeg 授權與編碼器（LGPL 版沒有 libx264；ffmpeg 現在只做代理檔與中間檔） | 已定（10/27）：打包 LGPL 版，硬體編碼優先，退路 `h264_mf`（Windows 內建） |
| WebView2 的 Worker 裡 WebGL 受限或讀回太慢 | 10/27 實測；不行就在沙盒 iframe 的主執行緒跑（隔離一樣靠 iframe）；再不行，3D 改用外部素材（D14） |
