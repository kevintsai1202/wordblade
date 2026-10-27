# 一鍵片頭：片頭風格調查與範本設計

調查日期：2026-10-27。範圍：只做調查與建議，沒有改程式或 `docs/spec.md`。

功能構想：使用者給多張封面圖（例如課程封面）、標題、副標、icon，可選自己的音樂，按一下就在時間軸開頭生成片頭：快速翻頁閃過多張圖 → 閃光 → 字卡加 icon 揭曉，附翻頁、轉場音效與配樂。

> 命名注意：產品內稱「翻頁式片頭」，不要用 Marvel 名稱、logo 或配樂。brand-v2 的 README 也寫明是「原創致敬，未使用漫威的 logo 或配樂」。

---

## 1. 之前做過的「漫威風格片頭」

### 1.1 找到的位置

| 項目 | 路徑 |
| --- | --- |
| 專案 | `D:\GitHub\yt任務\片頭片尾\brand-v2\`（README 有完整分鏡與重出片步驟） |
| 完整版（19.2 秒） | `brand-v2\intro\index.html`，成品 `D:\GitHub\yt任務\片頭片尾\片頭-v2.mp4` |
| 短版（9.6 秒） | `brand-v2\intro-short\index.html`，成品 `片頭-v2-短版.mp4` |
| 翻頁動畫參數 | `brand-v2\intro\index.html:1050-1061`（短版 `intro-short\index.html:759-770`） |
| 閃光、字內透封面、揭曉 | `brand-v2\intro\index.html:1070-1087` |
| 翻頁音效合成 | `brand-v2\scripts\make_flip_sfx.py` |
| 封面雙色調 | `brand-v2\scripts\fetch_thumbnails.py:54-55`（色點）、`:73-79`（`duotone()`） |
| 配樂重拍分析 | `brand-v2\scripts\analyze_music.py` |
| 兩版常數 | `brand-v2\scripts\profiles.py` |
| 素材授權 | `brand-v2\LICENSE-NOTES.md` |
| 記憶紀錄 | `C:\Users\kevintsai\.deep-memory\experience\skill-hyperframes.md:59-69`、`cold-notes\raw.jsonl` 第 4512、4528 行（2026-10-18 兩筆） |

D:\GitHub 底下其他提到「漫威」的檔案（`yt任務\AI能力進化盤點\` 的腳本、字幕、盤點）都只是引用這支片頭，沒有另一份實作。搜尋範圍：`yt任務` 全部，以及幾個影片相關專案（hyper-frames、learn-hyperframes、promo_vedio、mini-plm-promo、video-editor 等）；整個 D:\GitHub 全掃會逾時，沒有掃完。

### 1.2 工具鏈

- **畫面**：HyperFrames（HTML 寫影片，`hyperframes@0.8.169`）＋ GSAP timeline，CSS 3D transform（`perspective: 1800px`）。1920×1080、30 fps。
- **封面**：`fetch_thumbnails.py` 從 YouTube 抓頻道影片封面（`maxresdefault`，退 `hqdefault`），固定種子隨機挑 16 張翻頁、7 張字內透封面，PIL 縮成 1600×900 並轉品牌藍紫雙色調後寫進 HTML。
- **翻頁音效**：`make_flip_sfx.py` 用 numpy 合成，不用外部素材；其他音效（typing、click、whoosh、whoosh-cinematic、impact-bass-1、pop、ping、sparkle）來自 Pixabay（media-use 技能內附）。
- **配樂**：Mixkit 免費曲 Digital Clouds（正式版）、Kodama Night Town（備選）。
- **口白**：Fish Audio `drama-3`、自建聲音模型，Whisper 對時把逐字時間寫進 `BEATS`。
- **收尾**：`finalize.py` 響度處理到 -16 LUFS，`verify_intro.py` 驗收（揭曉前後 Whisper、三段響度、抽格）。

WordBlade 不能直接沿用這套（HyperFrames、GSAP、Python 都不在我們的執行環境）；可以搬的是**參數、節奏與合成方法**，程式要重寫成 three.js 插件與宣告式 `Synth`。

### 1.3 分鏡與時間（完整版 19.2 秒）

| 時間（秒） | 畫面 | 聲音 |
| --- | --- | --- |
| 0–2.6 | 暗場 1.3 秒亮起，對話框淡入、打字「教我用 AI 寫程式」→ 送出，對話框放大 1.5 倍衝出 | 配樂淡入；typing 1.67、click 2.42、whoosh 2.5 |
| 2.75–5.5 | 翻頁：16 張雙色調封面以上緣為軸翻下，先慢後快；整個舞台推近；兩道光暈掃過（3.3 藍、4.6 紫） | swell（whoosh-cinematic）3.46 起 2.7 秒；翻頁音效每頁一聲（wav 從 2.7 起、長 3.26 秒） |
| 5.46–5.5 | 全片唯一閃光：0.06 秒升到不透明度 0.85，0.35 秒退 | impact-bass-1 於 5.86 起播 |
| 5.5–6.0 | 「凱文大叔」藍色方塊從 1.22 倍縮入（0.4 秒 `power3.out`），字裡依序透出 7 張封面（每張約 0.071 秒≈2 格） | 推到最高點 |
| 6.0 | 揭曉：轉實心白字（0.12 秒）、方塊變亮並彈 1.04 倍；頭像 7 步去噪（每步 0.05 秒）；副標逐字串流（每字 0.13 秒）；6.6 斜光掃過字 | 配樂重拍落地，同時喊「凱文大叔！」 |
| 6.3–18.3 | 主題卡、按讚／訂閱／小鈴鐺 CTA、置中放大與掃光 | 口白；pop、click、ping、sparkle 對準口白關鍵詞 |
| 18.75–19.2 | 淡出到黑 | |

短版（9.6 秒）同樣結構但壓縮：翻頁 0.9–2.7、閃光 2.7、揭曉 3.2，沒有主題卡。

### 1.4 翻頁節奏（核心參數）

```js
// brand-v2/intro/index.html:1050-1061
const MONTAGE_START = 2.75, CLIMAX = 5.5;
// 舞台：scale 0.72→1.32、rotationY -10→8、rotationX 6→-2，ease power1.in（越來越快地推近）
let t = MONTAGE_START, gap = 0.42;
for (i = 0; i < PAGES && t < CLIMAX; i++) {
  set(page[i], { opacity: 1 }, t);   // 一開始就設 1，用漸變會兩頁半透明疊字
  fromTo(page[i], { rotationX: -105 }, { rotationX: 0, duration: min(0.55, gap * 1.5), ease: "power2.out" }, t);
  t += gap; gap = max(0.067, gap * 0.86);   // 每頁間隔乘 0.86，最短 2 格
}
```

- 頁面：1600×900、圓角 18 px、`transform-origin: 50% 0%`（上緣為軸）、`backface-visibility: hidden`、陰影 `0 30px 80px rgba(0,0,0,.6)`。
- 換算到 three.js：CSS `perspective: 1800px`、畫面高 1080 對應的垂直視角約 `2·atan(540/1800) ≈ 33.4°`。

逐頁停留（完整版，30 fps 換算）：

| 頁 | 開始（秒） | 間隔（秒） | 格數 |
| --- | --- | --- | --- |
| 1 | 2.750 | 0.420 | 12.6 |
| 2 | 3.170 | 0.361 | 10.8 |
| 3 | 3.531 | 0.311 | 9.3 |
| 4 | 3.842 | 0.267 | 8.0 |
| 5 | 4.109 | 0.230 | 6.9 |
| 6 | 4.339 | 0.198 | 5.9 |
| 7 | 4.536 | 0.170 | 5.1 |
| 8 | 4.706 | 0.146 | 4.4 |
| 9 | 4.852 | 0.126 | 3.8 |
| 10 | 4.978 | 0.108 | 3.2 |
| 11 | 5.086 | 0.093 | 2.8 |
| 12 | 5.179 | 0.080 | 2.4 |
| 13 | 5.259 | 0.069 | 2.1 |
| 14–16 | 5.328、5.395、5.462 | 0.067 | 2.0 |

16 頁剛好在 5.5 秒前翻完。短版起始間隔 0.26（7.8 格），0.9 起到 2.68 也是 16 頁，第 10 頁起就到 2 格下限。

### 1.5 字卡動畫

- 「字內透封面」：7 層同一行字，每層 `background-image` 是一張雙色調封面，`background-clip: text`；閃光到揭曉之間輪流顯示（每層約 2 格），揭曉時換成白字。
- 揭曉的「重量感」來自四件事同時發生：白字、方塊變亮、1.04 倍彈跳、配樂重拍；0.6 秒後再補一道斜光掃過。

### 1.6 音效與配樂

- **翻頁音效**（`make_flip_sfx.py`）：每頁一聲，三層濾波雜訊，固定種子 `20261018`：
  1. 揮動：2–9 kHz 帶通雜訊，先升後降，峰值在 62%×0.8 處，增益 0.55。
  2. 沙沙：1.2–6 kHz 帶通雜訊乘上隨機包絡（每 400 取樣一個隨機值、再以 240 點 hanning 平滑；docstring 標約 40–90 次／秒），峰值在 62%×0.7，增益 0.4。
  3. 落下：在 62% 處的 50 ms「啪」，250–1400 Hz（0.9）＋3–12 kHz（0.35），指數衰減。
  - 每聲長度 `clamp(gap×1.2, 0.09, 0.32)` 秒；增益隨速度從 1.0 降到 0.55；口白開始後再 ×0.6；左右聲道 ±0.18 交錯。
  - 翻頁參數用 regex 從 index.html 讀回來，避免動畫與音效不同步。實測（記憶紀錄）：前 8 聲清楚，間隔小於 0.13 秒的後段會連成一片沙沙聲，被 swell 與口白蓋過，屬預期。
- **配樂對拍**：Digital Clouds `data-media-start = 23.861`，曲中 29.861 秒的重拍落在片頭 6.0 秒。`analyze_music.py` 的做法：頻譜通量（spectral flux）當 onset → 自相關估 BPM（限 70–180）→ 找最佳拍點相位 → 在拍點中找「前 2 秒偏安靜、後 1 秒變大聲」分數最高者當重拍 → 在 ±0.15 秒內微調到 onset 最強處 → `media_start = hit_at − 片頭重拍時間`。注意這支腳本的 `INTRO_HIT_AT` 還是 5 秒舊版的 2.70（`analyze_music.py:22`），而目前的起點滿足 `23.861 = 29.861 − 6.0`；起點怎麼從 2.70 版改到 6.0 版，檔案裡沒有紀錄。記憶紀錄另有選曲時的響度包絡量測（ebur128 每 0.5 秒）：Digital Clouds 在翻頁期掉進間奏，Kodama 從 3.218 起單調上升到重拍（+12.7 dB）。
- **混音**：口白段比高潮小 4 LU 時，配樂與 impact／swell 降 3.5 dB；口白開始先壓到 0.6、揭曉後 0.35 秒再壓到 0.2（不能一開口就 duck，會殺掉漸強）。

### 1.7 可以帶到 WordBlade 的經驗

- 一個錨點：**揭曉時間 `reveal`** 決定一切，翻頁、閃光、音效、配樂起點都由它往回推。
- 翻頁音效要和動畫**讀同一份時間表**；brand-v2 是用 regex 回讀 HTML，WordBlade 應該由範本一次算出 cue 表，畫面與聲音都從它衍生（見 §3）。
- 頁面不透明度要瞬間設 1，不要漸變。
- 每頁至少 2 格；快段的音效會連成一片，所以快段每聲要短、要小。
- 閃光全片只用一次。

---

## 2. 片頭風格清單

證據等級：網路來源多半是模板商店頁，給的是元素描述，很少給節奏數字。有出處的數字只有：AEJuice 的漫威式教學（12 秒、18–22 張）、YouTube 片頭建議長度（創作者部落格的共識，不是官方規定：多數 3–5 秒、上限約 20 秒）、Premiere 靜態圖預設 5 秒、BPM 換格數公式、light leak 用 Screen 合成。下表其他的秒數、格數是**建議值**，標「建議」。

對拍換算：每拍格數 = fps × 60 ÷ BPM。30 fps 時 120 BPM＝15 格、128 BPM＝14.06 格、90 BPM＝20 格。

各風格「我們怎麼做」都套用 spec 的現況限制：

- Canvas 2D 只有仿射變換、**沒有透視**，所以翻頁、卡片飛入、穿越這類要透視的走 three.js 插件。
- 插件每格限時 2D 30 ms、3D 100 ms；影片畫面貼進 three.js 用 `NoColorSpace`（§5.7）。
- 合成器現有可重用的：圖片片段、透明度、淡入淡出、子母畫面框（`Clip.transform`）、局部放大關鍵幀（`Clip.zoomKeys`，1–4 倍，§5.19）；轉場（溶接、穿黑／白、推移、推近）是 P2（§5.9）；色彩調整是 P3。
- 插件目前**拿不到使用者的多張圖**（`env` 只有當格畫面），見 §4 缺口 1。

### 2.1 翻頁式（Marvel flip）

- **視覺特徵**：多張圖像書頁或翻頁書一樣快速翻過，越翻越快、鏡頭推近，最後閃光切到標題。Marvel Studios 2002 年起用 Imaginary Forces 做的漫畫翻頁 logo，2013 年《雷神索爾 2》改成 3D 立體字，2025 年《Thunderbolts*》又回到翻頁概念。
- **長度與節奏**：AEJuice 教學用 12 秒合成、18–22 張漫畫格；brand-v2 翻頁段 2.75 秒、16 張、每張 12.6 格遞減到 2 格（§1.4）。建議片頭總長 6–9 秒（短版結構：0.9 秒起翻、3.2 秒揭曉）。對拍：前幾頁可以對拍（120 BPM 時第一頁 1 拍＝15 格），加速段不對拍、用遞減；揭曉對重拍。
- **組成**：頁面以上緣為軸翻下（-105°→0°）＋舞台推近微轉＋光暈掃過＋一次閃光＋字內透圖的標題＋揭曉彈跳。音效：swell／riser 覆蓋翻頁段、每頁一聲翻頁、閃光前後 impact、揭曉後 sparkle。
- **我們怎麼做**：
  - 畫面：3D 插件（three.js）。每頁一個 `PlaneGeometry`，幾何先平移讓原點在上緣，轉 `rotation.x`；`PerspectiveCamera` 約 33° 視角，相機 z 推近代替舞台 scale。光暈與閃光用加色混合的全畫面平面，或交給一個 2D 插件疊上。
  - 字內透圖：2D 插件畫字後 `globalCompositeOperation = "source-in"` 再 `drawImage` 封面即可（Canvas 2D 做得到）；也可以畫進 OffscreenCanvas 當 three.js 的 `CanvasTexture`。
  - 雙色調：插件裡用 `ShaderMaterial` 以漸層表上色（參數 `tone`），不另存檔；或範本預先算成衍生圖片素材（像聲音分離的 `Stem`）。
  - 聲音：翻頁 `Synth`（三個雜訊聲部＋帶通，見 §3.4）、riser、impact。
  - 不需要 Muse Image。
- **使用者素材**：8–20 張圖（少於 8 張就循環使用）、標題、副標、icon（可選）、音樂（可選）。
- **來源**：AEJuice「How to Create a Marvel-Style Intro in After Effects」；/Film 2016 新 logo 報導；Post Magazine 2025 Imaginary Forces《Thunderbolts*》報導。

### 2.2 節拍切圖幻燈片（beat-cut flash montage）

- **視覺特徵**：每張圖全畫面硬切，跟著拍子換，切點加短閃白或縮放衝擊，最後標題卡。
- **長度與節奏**：建議 4–8 秒。每張 1 拍（120 BPM＝15 格），最後 2–4 張可改半拍（7.5 格→實際交替取 7／8 格）製造加速；只在樂句（2、4、8 拍）上放大動作，不要每拍都加特效（來源指出每拍都切會顯得慌亂、最大的畫面時刻放在 drop）。
- **組成**：圖片硬切＋每切一個 1.05→1.0 的縮放衝擊或 2 格閃白；音效以配樂鼓點為主，可加 whoosh 在換段、impact 在標題。
- **我們怎麼做**：幾乎全用現有功能——V1 放圖片片段（長度＝拍長），`zoomKeys` 做縮放衝擊；閃白用一個 2D 插件（全畫面白色，透明度依 cue 表）或 P2 的穿白轉場；標題卡用 2D 插件「文字彈出」範本。不需要 Muse Image。
- **使用者素材**：4–16 張圖、標題、音樂（建議有，節拍感主要來自音樂）。
- **來源**：silvermansound BPM to FPS；artfolio「Synced cuts and BPM」。

### 2.3 Ken Burns 慢幻燈片

- **視覺特徵**：靜態照片緩慢推拉、平移，溶接換圖，氣氛溫和（紀錄片、回顧、課程總覽）。
- **長度與節奏**：Premiere 靜態圖預設每張 5 秒；片頭用建議每張 1.5–2.5 秒（約 2–4 小節，90 BPM 時 1 小節 2.67 秒）、總長 6–10 秒，溶接 0.5 秒。
- **組成**：每張 1.0→1.15 倍放大加小幅平移（方向交錯）＋溶接＋最後標題淡入；音效極少（可以只有配樂，標題出現時一聲柔和的 chime）。
- **我們怎麼做**：V1 圖片片段＋`zoomKeys`（兩個關鍵幀＝起訖框）；溶接需要 §5.9 轉場（P2），在那之前可以用 V1／V2 交錯擺放＋淡入淡出近似。標題用 2D 插件。這是成本最低的風格。
- **使用者素材**：3–8 張圖、標題、音樂。
- **來源**：Adobe「Ken Burns effect」教學（圖片預設 5 秒）；mko.re「Ken Burns with ffmpeg」（zoompan 範例 4 秒 25 fps）。

### 2.4 格狀拼貼 → 標題（grid mosaic reveal）

- **視覺特徵**：多張圖排成格子牆，逐格彈入、整面牆移動或縮放，最後收攏成標題（或標題字當遮罩透出拼貼）。
- **長度與節奏**：模板常見 10–15 秒（Envato 的 mosaic logo intro 是 15 秒），片頭建議 5–8 秒。格子逐一出現的間隔用半拍（120 BPM＝7.5 格），整面牆動作放在小節頭，收攏對重拍。
- **組成**：格子 stagger 彈入（`back.out` 類緩動）＋牆面緩慢推近或斜移＋收攏或放大穿進其中一格＋標題。音效：每格出現一個短 pop／tick（可以對半拍），收攏 whoosh，標題 impact。
- **我們怎麼做**：2D 插件（格子只需仿射變換，Canvas 2D 夠用）；要做斜角透視的牆就改 3D 插件。標題遮罩透圖同 §2.1。需要插件拿得到多張圖（§4 缺口 1）。不需要 Muse Image。
- **使用者素材**：4–16 張圖（格子數 2×2、3×3、4×4 依張數自動選）、標題、副標。
- **來源**：VideoBolt「Multi Image Reveal」「Multi Photo Logo Opener」「InstaGrid Reveal」；Envato「Mosaic Logo Intro」。

### 2.5 Logo reveal（光掃、遮罩擦出）

- **視覺特徵**：只有 logo／icon 與名稱，透過光線掃過、遮罩擦出、粒子聚合等方式出現。常當其他風格的結尾。
- **長度與節奏**：建議 3–5 秒；YouTube 片頭建議 3–5 秒的範圍內最常見。揭曉對重拍，前面 1–2 秒醞釀（riser）。
- **組成**：暗場 → 光暈或粒子聚集 → 遮罩擦出 logo（漸層 wipe）→ 一道斜光掃過 → 名稱與副標淡入。音效：riser → impact（或 reverse cymbal → hit）→ shimmer。
- **我們怎麼做**：2D 插件（`createLinearGradient` 當遮罩、`globalCompositeOperation` 做透出與 `lighter` 發光、粒子）。使用者沒有 icon 時可以用 Muse Image 生一個（只生圖形，字不交給模型畫，§5.12 實測拉丁字會拼錯）。
- **使用者素材**：icon／logo（透明 PNG 最好）、名稱、副標。
- **來源**：Speckyboy 免費 logo reveal 模板整理；AEJuice 教學後段的 Gradient Wipe 揭曉。

### 2.6 動態文字（kinetic typography）

- **視覺特徵**：標題、副標、關鍵字一個個跳出、縮放、滑動，字本身就是畫面主角。
- **長度與節奏**：建議 4–8 秒；每個詞對一拍或對口白的那個字。來源建議旁白節奏約每秒 2 個詞，關鍵句講完後至少停一拍再走；每個進出都要緩動。
- **組成**：詞依序進場（縮放、遮罩上推、打字機）＋相機在排好的句子上移動（比逐字母動畫好讀）＋最後組成完整標題。音效：每詞一聲 tick／pop 或鍵盤聲，結尾 impact。
- **我們怎麼做**：2D 插件（打字機、文字彈出已在 §5.7 範本清單）。若片頭有口白（例如 Fish TTS 一句招呼），`env` 本來就有逐字稿與時間，可以讓字跟著口白出現——這是 WordBlade 的優勢。字型要能在 Worker 裡的 OffscreenCanvas 載入（`FontFace` 在 Worker 的支援度**需驗證**）。
- **使用者素材**：標題、副標、2–6 個關鍵字（可選口白）；不需要圖。
- **來源**：Pexo「How to make a kinetic typography explainer video」；Oakgen「Kinetic typography without After Effects」；PremiumBeat kinetic typography tutorial。

### 2.7 Glitch（數位故障）

- **視覺特徵**：RGB 分離、橫向撕裂位移、雜訊方塊、掃描線、閃爍，科技感、電競感。
- **長度與節奏**：建議 3–6 秒；故障爆發只放在拍點上（每拍 2–4 格的爆發，其餘時間穩定），揭曉前一拍最密。
- **組成**：圖片或標題在故障爆發中切換＋RGB split（紅藍反向位移）＋位移帶＋雜訊；音效：數位雜訊 burst、bit-crush、短 click、低頻 hit。
- **我們怎麼做**：故障是畫素級運算，Canvas 2D 要 `getImageData`（1080p 一格 8 MB，30 ms 預算內不保險），所以用 3D 插件當「全畫面 shader」：當格畫面或圖片當貼圖，片段著色器做通道位移、帶狀 UV 偏移、雜訊。音效 `Synth` 用雜訊聲部＋快速 ADSR＋失真效果，正好是 §5.15 音效 spec 能表達的。
- **使用者素材**：2–8 張圖或只要標題、icon。
- **來源**：PremiumBeat「Glitch effect tutorial」（RGB split 是最常見元素）；ProVideo Coalition「Chromatic aberration」；VideoBolt「Glitch Opener」。

### 2.8 Film burn／light leak（漏光、燒片）

- **視覺特徵**：暖色光斑從畫面邊緣漫入，像底片漏光或燒片，換圖時最亮那一刻遮住切點。復古、溫暖、婚禮與旅遊常見。
- **長度與節奏**：建議 5–8 秒；漏光每次 0.5–1 秒，最亮點對準切點（來源做法：把漏光最亮那格對到剪接點）；溫和曲風 80–100 BPM，每 2 小節換一張。
- **組成**：圖片（常搭 Ken Burns）＋漏光疊層以 Screen 或 Add 合成＋底片顆粒；音效：底片放映機轉動、柔和 whoosh、配樂為主。
- **我們怎麼做**：2D 插件就能畫——幾個移動的放射漸層＋`globalCompositeOperation = "screen"`（或 `lighter`＝Add），顆粒用固定種子雜訊。不需要漏光素材檔（避免授權問題）。底下的圖片沿用 §2.3 的片段＋`zoomKeys`。
- **使用者素材**：3–8 張圖、標題。
- **來源**：tutvid「How to Create a Light Leak Transition in Premiere Pro」；InVideo「Light leaks overlays」；No Film School／PremiumBeat「3 ways to use light leaks」。

### 2.9 分割畫面（split-screen）

- **視覺特徵**：畫面切成 2–4 格，各格同時播不同圖或影片，格子滑入、擴張，最後合成一張或讓位給標題。
- **長度與節奏**：建議 4–6 秒；每個格子進場對一拍，最後擴成全畫面對重拍。
- **組成**：格子以遮罩從不同方向滑入＋分隔線＋各格內 Ken Burns＋最後一格擴張或全部收合成標題；音效：每格一聲 swipe／whoosh，結尾 impact。
- **我們怎麼做**：靜態分格可以直接用 V2 以上的片段＋`Clip.transform`（子母畫面框）；但框目前不能做關鍵幀，滑入動畫要嘛補 transform 關鍵幀，要嘛整段交給 2D 插件畫（需要插件拿得到圖）。
- **使用者素材**：2–4 張圖或短影片、標題。
- **來源**：PremiumBeat「Split screen reveal」；ShortGenius「Split screen video editing」。

### 2.10 3D 卡片飛入／畫廊穿越（3D card fly-in）

- **視覺特徵**：多張圖像卡片排在 3D 空間（弧形、螺旋、走廊），相機飛過，卡片翻轉、浮動，最後停在標題。
- **長度與節奏**：建議 6–10 秒；相機路徑速度可以對小節（每小節經過 1–2 張卡）。
- **組成**：卡片陣列＋相機沿曲線移動（Codrops 教學用 Blender 曲線轉 JSON、GSAP 驅動）＋景深或霧＋卡片反光＋最後卡片散開露出標題；音效：連續低頻 drone／riser、經過每張卡的 whoosh（左右聲道依位置擺）、標題 impact。
- **我們怎麼做**：3D 插件，和翻頁式共用「圖片進 three.js」的基礎（多張貼圖、`NoColorSpace`）。相機路徑可以重用 `Effect.cameraKeys`。軟體算繪的電腦用 720p 算（§5.21）。
- **使用者素材**：6–20 張圖、標題；背景可選 Muse Image 生成的場景圖。
- **來源**：Codrops「Scroll-Reactive 3D Gallery with Three.js」（2026-03）、「Scroll-Driven 3D Gallery Using a Blender Camera Path」（2026-07）。

### 2.11 鏡頭穿越（zoom-through）

- **視覺特徵**：鏡頭不斷向前衝進下一張圖（圖一層層排在深度上，或從一張圖的某個點放大進去接下一張），搭配放射模糊。
- **長度與節奏**：建議 4–7 秒；每次穿越約 20 格（AEJuice zoom blur 教學用約 20 格的調整圖層橫跨切點），對拍時一拍穿一張。
- **組成**：放大＋放射模糊在切點最強＋下一張從模糊中縮回；音效：每次穿越一個 whoosh（峰值對切點）、結尾 impact。
- **我們怎麼做**：兩種：①沒模糊的版本用 V1 片段＋`zoomKeys` 在切點前放大到 4 倍、下一段從 4 倍縮回（現有功能就能做）；②要放射模糊或真正的深度穿越用 3D 插件（片段著色器做 radial blur，或平面排在 z 軸上相機前進）。
- **使用者素材**：3–10 張圖、標題。
- **來源**：AEJuice「Smooth Zoom Blur Transitions」；tutvid「Blurred zooming transition」；Film Impact「Seamless zoom transitions」。

### 2.12 YouTuber 頻道片頭（頭像＋名稱＋訂閱提示）

- **視覺特徵**：頭像或 logo＋頻道名＋一句定位標語，常接「按讚、訂閱、小鈴鐺」游標點擊動畫；brand-v2 完整版的後半段就是這種。
- **長度與節奏**：logo 揭曉約前 3 秒，含 CTA 的版本 5–10 秒；CTA 每個按鈕的點擊對口白的那個詞（brand-v2 用 Whisper 對時）。
- **組成**：頭像彈入＋名稱揭曉＋標語串流＋按鈕列滑入＋游標點擊（按下縮 0.93、彈回 `back.out`、漣漪擴散、鈴鐺搖擺）；音效：click、ping、sparkle，可加口白（Fish TTS）。
- **我們怎麼做**：2D 插件；按鈕圖示用內建向量圖。有口白時用 §5.6 的 Fish Audio 生一句招呼，`env` 逐字稿驅動點擊時間。頭像可用 Muse Image 改風格（例如 brand-v2 的「去噪浮現」需要多張中間步驟圖，可改成插件裡的模糊→清晰）。
- **使用者素材**：頭像、頻道名、標語，可選口白文字。
- **來源**：Renderforest、Marmoset「How long should a YouTube intro be」；Kapwing subscribe 動畫模板；VideoBolt「YouTube Clean」。

---

## 3. 片頭範本的共通資料結構

### 3.1 原則：範本是「產生器」，輸出一組專案變更

一鍵片頭**不是一個插件**，而是一個純函式：吃輸入、吐出一組要加進 `Project` 的東西（片段、特效區段、`Synth`、音效擺位），再由同一套編輯純函式寫進時間軸（可以 Ctrl+Z 一次復原）。原因：

- 一支片頭同時要動 V 軌、特效、A2 配樂、A3 音效，跨了好幾種資料。
- `Plugin.soundIds` 只能說「用哪個 Synth」，說不出「16 聲各在幾秒」；brand-v2 是把 16 聲預混成一支 WAV。WordBlade 更合資料模型的做法是：範本算出時間，產生 N 個 A3 `Clip` 指向同一個 `Synth` 算好的素材（`renderedMediaId`），每個片段各自設音量。這樣使用者還能在時間軸上微調某一聲。
- 畫面與聲音從**同一份 cue 表**衍生，保證同步（避免 brand-v2 用 regex 回讀 HTML 的做法）。

### 3.2 型別草案（TS 核心，純函式、Vitest 可測）

```ts
/** 片頭風格的定義（內建範本，一種風格一筆） */
interface IntroStyle {
  id: IntroStyleId;                    // "flip" | "beatcut" | "kenburns" | "grid" | ...
  label: string;
  imageCount: { min: number; max: number; recommended: number };
  paramSchema: Record<string, unknown>; // 風格參數的 JSON Schema（也給 Vibe特效／AI 改參數用）
  defaults: IntroTiming & Record<string, unknown>;
  /** 純函式：輸入＋音樂分析 → 片頭計畫 */
  build(req: IntroRequest, beat: BeatGrid): IntroPlan;
}

/** 使用者的輸入 */
interface IntroRequest {
  styleId: IntroStyleId;
  imageIds: string[];         // 素材庫裡的圖片（Media.kind = image）
  title: string;
  subtitle?: string;
  iconId?: string;            // icon／logo 圖片
  music:
    | { kind: "media"; mediaId: string; dropAt?: Seconds }  // 使用者的音樂；dropAt 手動指定重拍（曲內時間）
    | { kind: "generate"; bpm: number; mood: string }       // 用 §5.15 配樂 spec 生成
    | { kind: "none" };
  timing: Partial<IntroTiming>;
  params: Record<string, unknown>; // 依 paramSchema（例：tone、gap0、ratio、minFrames、flash）
  insertAt: Seconds;          // 通常是 0
  seed: number;               // 圖片洗牌、音效雜訊的固定種子
}

/** 時間設定：以揭曉時間 reveal 為錨點 */
interface IntroTiming {
  reveal: Seconds;            // 重拍落地＝標題揭曉（翻頁式預設 3.2）
  duration: Seconds;          // 片頭總長（預設 reveal + 3～4 秒）
  fps: number;                // 取專案 fps
  bpm?: number;               // 有音樂時由分析得到；無音樂時用來排節奏
}

/** 音樂分析結果（拍點以秒存，不先量化成格） */
interface BeatGrid {
  bpm: number | null;
  beats: Seconds[];           // 片頭時間軸上的拍點（已套用 musicOffset）
  downbeats: Seconds[];       // 小節頭
  musicOffset: Seconds;       // 配樂片段的 srcIn ＝ dropAt − reveal
  confidence: number;         // 0～1；太低就退回固定節奏並提示使用者
}

/** 時間點清單：畫面與聲音都從這裡衍生 */
interface IntroCue {
  t: Seconds;                 // 相對片頭開頭
  kind: "page" | "cut" | "tile" | "flash" | "riserStart" | "reveal" | "titleIn" | "subtitleIn" | "iconIn" | "end";
  index?: number;             // 第幾張圖／第幾格
  strength?: number;          // 0～1，給音效音量與畫面強度用（翻頁越快越小）
}

/** 範本輸出：要加進專案的東西 */
interface IntroPlan {
  duration: Seconds;
  cues: IntroCue[];
  clips: Clip[];              // V1 佔位或圖片片段、A2 配樂片段、A3 音效擺位（每個 cue 一個）
  effects: Effect[];          // anim3d／anim2d 區段；params 帶 imageIds、cues、title…，插件只依 t 與 params 畫
  synths: Synth[];            // 需要的音效／配樂 spec（內建範本 source = "builtin"）
  derivedMedia?: Media[];     // 例如預先轉好的雙色調圖（若不在插件裡上色）
  warnings: string[];         // 例：圖片不足已循環使用、BPM 信心低改用固定節奏
}
```

### 3.3 產生流程

1. 驗證輸入：圖片張數不足 `min` → 循環使用並寫進 `warnings`；超過 `max` → 用 `seed` 挑。
2. 音樂分析（§3.5）得到 `BeatGrid`；沒有音樂就用 `timing.bpm`（預設 120）產生等距拍點。
3. 風格的 `build()` 算 cue 表：以 `reveal` 為錨點往回排（翻頁式：`climax = reveal − 0.5`，從 `climax` 倒推遞減間隔決定 `montageStart`；或固定 `montageStart` 往後排，翻不完就截掉）。
4. 由 cue 表產生：
   - 畫面：一個或數個 `Effect`，`params = { imageIds, cues, title, subtitle, iconId, tone, ... }`。
   - 音效：每個聲音 cue 一個 A3 `Clip`（`mediaId` = 該 `Synth` 算好的 WAV，`volume` = 依 `strength`）。
   - 配樂：A2 一個 `Clip`，`srcIn = musicOffset`，`fadeIn`／`fadeOut`；生成的配樂則是 `Synth(kind: "music")`。
5. 寫進時間軸：在 `insertAt` 插入 `duration` 長的空間（未鎖定的軌往後移），放入以上內容，存成一次復原快照。
6. 預覽：照常由合成器播放；使用者可以改參數重算（同一個 `seed` 結果相同）。

### 3.4 翻頁式的具體對應（範例）

| 項目 | 值（取自 brand-v2，可當預設） |
| --- | --- |
| `params` | `gap0 = 0.42`（短版 0.26）、`ratio = 0.86`、`minGap = 2 / fps`、`pageAngle = -105°`、`stageScale = [0.72, 1.32]`、`flash = 0.85`、`titleFills = 7`、`tone = "duotone-brand"` |
| cue | `page` × N（`strength = 1 − 0.45 × 速度比`）、`riserStart`（約 `climax − 2.0`）、`flash`（`climax − 0.04`）、`reveal` |
| 翻頁 `Synth` | 三個雜訊聲部：揮動（白雜訊、bandpass 中心約 4.2 kHz、Q≈0.6、峰在 50%）、沙沙（白雜訊、bandpass 約 2.7 kHz、Q≈0.56）、落下（白雜訊、bandpass 約 590 Hz、Q≈0.53、在 62% 處 50 ms 指數衰減）；做「慢」0.32 秒與「快」0.12 秒兩個版本，間隔大於 0.13 秒用慢版 |
| riser `Synth` | 白雜訊＋highpass 截止頻率曲線 300 Hz→6 kHz，長度 `climax − riserStart + 0.2`，音量漸強 |
| impact `Synth` | 正弦振盪 60→35 Hz 下滑＋短雜訊爆發，ADSR 起音 5 ms、衰減 1.2 s，加殘響 |
| 配樂 | 使用者音樂：`srcIn = dropAt − reveal`；生成：見 §3.5 |

brand-v2 的「沙沙」顆粒是每 400 取樣跳一次的隨機包絡，§5.15 的 spec（ADSR）表達不了；要嘛在音效 spec 加一個「隨機振幅調變（rate、depth）」欄位，要嘛接受沒有顆粒的近似版。

### 3.5 對拍

**A. 使用者提供音樂：找 BPM 與重拍**

- 解碼：`AudioContext.decodeAudioData`（網頁版、Windows 版都有），轉單聲道。
- BPM 與第一拍：
  - 現成套件 `web-audio-beat-detector`（npm 8.2.39，**MIT**）：`guess(audioBuffer)` 回 `{ bpm, offset }`，預設 BPM 範圍 90–180（`tempoSettings` 可改，片頭常見的慢曲要放寬到 70）。演算法較簡單，對電子樂準。
  - 自己移植 `brand-v2/scripts/analyze_music.py`（約 100 行 numpy）：頻譜通量 → 自相關估 BPM → 拍點相位 → **找重拍**（前 2 秒安靜、後 1 秒變大聲的拍點）→ ±0.15 秒微調。它找的是「drop」而不只是 BPM，比套件更貼片頭需求；FFT 可用小型 TS FFT 或 Web Audio `AnalyserNode` 離線算。
  - 不要用 `essentia.js`（npm 0.1.3，**AGPL-3.0**，和 repo 預計的 Apache-2.0 不相容）。`realtime-bpm-analyzer`（Apache-2.0）、`bpm-detective`（MIT）可當備選。
- 建議：BPM 用套件、重拍用移植的評分函式，兩者都在 Worker 或主程式跑（10 秒音訊計算量很小）。結果給前 3 名候選讓使用者試聽選（brand-v2 也是這樣做）。
- 信心低（例如人聲為主、無鼓點）時：退回「整段音量包絡最陡上升點」當重拍，拍點改用固定 BPM，並在 `warnings` 提示。
- 需要的話先用 §5.14 聲音分離把人聲拿掉再分析（只有 Windows 版）。

**B. 沒有音樂：固定 BPM 生成配樂**

- 用 §5.15 的配樂 spec（速度、拍號、小節數、和弦、聲部），但由**內建範本** spec（`Synth.source = "builtin"`）參數化產生，不必呼叫 AI：例如 120 BPM、4/4，前 3 小節（6 秒）只有墊音＋上升琶音、第 4 小節第一拍鼓組與貝斯同時進＝重拍。
- 讓重拍落在小節頭：`reveal = 整數小節 × 每小節秒數`，或把配樂片段的 `srcIn` 往後推。片頭長 = 整數小節，結尾可以無縫接到正片配樂。
- 想要更有變化時再走 `/v1/ai/music`，把「第 N 小節是 drop」寫進請求。

**C. 量化成格**

- 公式：每拍格數 = fps × 60 ÷ BPM。30 fps 時 120、90 BPM 剛好整除（15、20 格），128 BPM 是 14.06 格。
- 拍點**以秒存**，不要逐拍四捨五入再累加（會漂移）；由合成器照既有規則 `Math.round` 換格。
- 視覺的「打擊」可以比拍點早 0–1 格（來源提到切點有時早或晚一格更好看）；做成 `params.hitLead`（預設 0）。

---

## 4. spec 需要補的決定

| # | 缺口 | 建議 |
| --- | --- | --- |
| 1 | 插件拿不到使用者的多張圖：`env` 只有當格畫面 | `Effect.params.imageIds` 由主程式在 `setup` 前解碼成 `ImageBitmap` 轉移進沙盒，放在 `env.images`（唯讀）；3D 插件做成貼圖、2D 插件 `drawImage`。圖先縮到 ≤ 1600 寬，16 張約 90 MB 記憶體 |
| 2 | 音效擺位：`soundIds` 沒有時間 | 範本產生 A3 `Clip`（多個片段共用一個 `Synth` 的 WAV）；或在 `Effect` 加 `soundCues: { synthId, t, gain }[]` 由離線混音放 |
| 3 | V1 不能留空（首尾相接），片頭期間 V1 要有東西 | 加一種「純色產生器」片段（或內建黑色圖片素材）當佔位，3D 插件畫整個畫面 |
| 4 | 插入：§4 只寫了漣漪刪除 | 補「漣漪插入」：在 `insertAt` 之後的未鎖定軌片段、`Effect`、時間軸 `Anchor` 右移 `duration` |
| 5 | 雙色調／調色 | 在插件 shader 裡做（推薦，不產生檔案）；或範本產生衍生圖片素材 |
| 6 | 音效 spec 表達力 | 翻頁的顆粒感需要「隨機振幅調變」；riser 需要濾波截止頻率曲線（spec 已有） |
| 7 | Worker 裡的字型 | 2D 插件畫標題要在 Worker 載入 `FontFace`；需實測 WebView2 Worker 的 `self.fonts` |
| 8 | 商標 | 介面與文件用「翻頁式片頭」，範本附的示範圖不要用任何真實品牌 |

---

## 5. 建議優先做的 3 種

選擇標準：同一組輸入（多張圖＋標題＋可選音樂）能不能直接重用、能不能沿用現有功能、成果在 demo 裡夠不夠搶眼。

1. **翻頁式（§2.1）**：使用者點名要的；brand-v2 已經把節奏、音效、配樂對拍都調好，參數可以直接搬（§1.4、§3.4）。它也會逼出缺口 1（多張圖進沙盒）與缺口 2（音效擺位）的解法，後面兩種都用得到。
2. **節拍切圖幻燈片＋Ken Burns（§2.2、§2.3 合為一個範本，參數切快／慢）**：幾乎只用現有功能（V1 圖片片段、`zoomKeys`、2D 標題插件），不依賴缺口 1，可以最先做出來、拿來驗證對拍流程（§3.5）。
3. **格狀拼貼 → 標題（§2.4）**：同樣吃多張圖，但 4–9 張就好看（翻頁式要 8 張以上），2D 插件就做得到，成本低；和翻頁式共用「字內透圖」標題與 cue／音效機制。

之後可以加：Logo reveal（§2.5，只要 icon）、Glitch（§2.7，3D 插件 shader）、3D 卡片飛入（§2.10，和翻頁式共用 three.js 圖片基礎）。

---

## 參考來源

漫威式片頭與 Marvel Studios logo

- AEJuice，How to Create a Marvel-Style Intro in After Effects：<https://aejuice.com/blog/how-to-create-a-marvel-style-intro-in-after-effects>
- /Film，New Marvel Studios Opening Logo（2016）：<https://www.slashfilm.com/new-marvel-studios-logo>
- Flickering Myth，Kevin Feige discusses Marvel Studios logo（2013）：<https://www.flickeringmyth.com/kevin-feige-discusses-marvel-studios/>
- Post Magazine，Imaginary Forces creates Marvel Studios logo featured in Thunderbolts*（2025）：<https://www.postmagazine.com/Press-Center/Daily-News/2025/Imaginary-Forces-creates-Marvel-Studios-logo-fea.aspx>

片頭長度與結構

- Renderforest，How Long Should a YouTube Intro Be：<https://www.renderforest.com/blog/how-long-should-youtube-intro-be>
- Marmoset，How Long Should A YouTube Intro Be：<https://www.marmosetmusic.com/journal/how-long-should-a-youtube-intro-be/>
- Teleprompter.com，How long should a YouTube intro be：<https://www.teleprompter.com/blog/how-long-should-a-youtube-intro-be>

各風格

- Adobe，Ken Burns effect（Premiere Pro）：<https://www.adobe.com/learn/premiere-pro/web/ken-burns-effect>
- mko.re，Ken Burns effect with ffmpeg：<https://mko.re/blog/ken-burns-ffmpeg/>
- PremiumBeat，Glitch effect tutorial：<https://www.premiumbeat.com/blog/glitch-effect-tutorial-after-effects/>
- ProVideo Coalition，Chromatic aberration：<https://www.provideocoalition.com/chromatic-aberration/>
- VideoBolt，Glitch Opener：<https://videobolt.net/author/paramall/glitch-opener>
- Pexo，How to make a kinetic typography explainer video：<https://pexo.ai/tutorial/how-to-make-a-kinetic-typography-explainer-video>
- Oakgen，Kinetic typography without After Effects：<https://oakgen.ai/blog/kinetic-typography-without-after-effects>
- PremiumBeat，Kinetic typography tutorial：<https://www.premiumbeat.com/blog/kinetic-typography-tutorial/>
- tutvid，Light leak transition in Premiere Pro：<https://tutvid.com/premiere-pro/create-light-leak-transition-premiere-pro/>
- InVideo，Light leaks／film burn overlays：<https://landing-pages.invideo.io/blog/light-leaks/>
- No Film School，3 ways to illuminate your film using light leaks：<https://nofilmschool.com/2016/03/3-ways-illuminate-your-film-using-light-leaks-premiumbeat>
- PremiumBeat，Split screen reveal：<https://www.premiumbeat.com/blog/adobe-after-effects-video-tutorial-split-screen-reveal/>
- ShortGenius，Split screen video editing：<https://shortgenius.com/blog/split-screen-video-editing>
- AEJuice，Smooth zoom blur transition：<https://aejuice.com/blog/how-to-create-a-smooth-zoom-blur-transition-in-after-effects/>
- tutvid，Blurred zooming transition：<https://tutvid.com/premiere-pro/best-blurred-zooming-transition-effect-premiere-pro-tutorial/>
- Film Impact，Seamless zoom transitions：<https://filmimpact.com/resources/video-tutorials/achieve-seamless-zoom-transitions-in-premiere-pro>
- Codrops，Scroll-Reactive 3D Gallery with Three.js（2026-03）：<https://tympanus.net/codrops/2026/03/09/building-a-scroll-reactive-3d-gallery-with-three-js-velocity-and-mood-based-backgrounds/>
- Codrops，Scroll-Driven 3D Gallery Using a Blender Camera Path（2026-07）：<https://tympanus.net/codrops/2026/07/07/building-a-scroll-driven-3d-gallery-using-a-blender-camera-path-with-three-js-and-gsap/>
- VideoBolt，Multi Image Reveal／Multi Photo Logo Opener／InstaGrid Reveal：<https://videobolt.net/author/Goldenmotion/multi-image-reveal-vertical>、<https://videobolt.net/author/harchenko/multi-photo-logo-opener>、<https://videobolt.net/author/kalinichev/instagrid-reveal>
- Envato，Mosaic Logo Intro：<https://elements.envato.com/mosaic-logo-intro-AC6SWLB>
- Speckyboy，Free logo reveal After Effects templates：<https://speckyboy.com/free-logo-reveals-after-effects-templates.md>
- Kapwing，Animated YouTube subscribe button template：<https://www.kapwing.com/explore/animated-youtube-subscribe-button-template>
- VideoBolt，YouTube Clean：<https://videobolt.net/author/luisbranco/youtube-clean>

聲音與對拍

- Silverman Sound，BPM to FPS Calculator：<https://www.silvermansound.com/bpm-to-fps-calculator>
- Artfolio，Synced cuts and BPM：<https://www.artfolio.com/article/synced-cuts-and-bpm-brief-templates-that-align-artists-with-music-video-crews>
- Violet Recording，Sound design for trailers：<https://violetrecording.com/sound-design-for-trailers/>
- IRPR，Riser（glossary）：<https://sounddesign.irpr.agency/glossary/riser/>
- web-audio-beat-detector README：<https://cdn.jsdelivr.net/npm/web-audio-beat-detector@8.2.37/README.md>（授權以 npm registry 查證：8.2.39 MIT）
- npm registry 授權查證（2026-10-27）：`web-audio-beat-detector` MIT、`essentia.js` AGPL-3.0、`realtime-bpm-analyzer` Apache-2.0、`meyda` MIT、`bpm-detective` MIT
