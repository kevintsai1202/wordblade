# Demo 影片腳本（3 分鐘，英文旁白）

依官方規則（2026-11-03 對照）：長度 3 分鐘；只展示黑客松期間做的功能；不必真人露臉。
不入鏡：人聲分離、2D 內建範本（沿用先前專案，見 README「Reused code」）。2D 只展示 Vibe 一句話生成。
影片本身用 WordBlade 剪（spec §9）。旁白可以自己錄，錄完也交給 WordBlade 轉字幕、讓 AI 導演剪重講。

## 要準備的素材

| # | 素材 | 怎麼拿 |
| --- | --- | --- |
| R1 | 原始錄影：你對著螢幕講解一段程式（2～3 分鐘，故意重講一次、說幾個 um、畫面上出現假 API 金鑰） | 可以直接用範例專案的 `public/sample/media/demo-2min.mp4` |
| S1 | 螢幕錄影：開影片 → 轉字幕 → 改字剪片 | Windows 版或網頁版，OBS／Xbox Game Bar 錄 |
| S2 | 螢幕錄影：AI 導演看完整支 → 建議清單 → 逐條採用（重講、遮金鑰、放大） | 同上 |
| S3 | 螢幕錄影：SAM 遮罩打字「API key」→ 追蹤 → 馬賽克 | 同上 |
| S4 | 螢幕錄影：Vibe 2D 一句話 → 動畫出現；Vibe 3D 一句話 → 獎盃 | 同上（需權杖） |
| S5 | 螢幕錄影：3D 場景，打一句話描述運鏡 → 鏡頭照著走 | 同上 |
| S6 | 螢幕錄影：逐字高亮字幕、AI 音效／配樂、Re-voice、發佈包（標題＋縮圖）、匯出 | 同上 |
| F1 | 成品：特效範例匯出檔（避開 12、38、70、104 秒的 2D 內建範本） | `output/sample-effects-export.mp4` |
| A1 | 架構圖 | README 的架構 |

## 分鏡與旁白

| 時間 | 畫面 | 旁白（英文） | 標註（畫面角落） |
| --- | --- | --- | --- |
| 0:00–0:20 | F1 精華快剪：Vibe 3D 獎盃、影片飛進桌上螢幕、鏡頭推近、逐字高亮字幕、金鑰被馬賽克。最後打字卡 | "Every effect you just saw was written by an AI from one sentence. And this video was edited by WordBlade." | 字卡：This video was edited by WordBlade |
| 0:20–0:40 | R1 原始錄影（快轉、標出重講與 um） | "I record coding tutorials. Turning a raw recording like this into something I can publish takes me hours: cutting retakes, hiding secrets, adding captions and motion. WordBlade does it by editing words, with Meta's models doing the heavy lifting." | |
| 0:40–1:00 | S1：匯入 → 字幕出現 → 刪掉幾個字，時間軸跟著剪 | "Muse Voice Transcribe gives me the transcript. I rebuild word-level timing from the audio, so deleting a word cuts the video." | Muse Voice Transcribe |
| 1:00–1:25 | S2：AI 導演跑完，清單出現 → 逐條採用 | "The AI director watches the whole recording. Muse Wonder plans, Muse Spark reviews each segment, and it proposes cuts for retakes, a mask for the leaked key, zooms and fixes. I accept them one by one." | Muse Wonder + Muse Spark 1.3 |
| 1:25–1:40 | S3：打「API key」→ SAM 追蹤 → 馬賽克 | "To hide something, I just type what it is. SAM 3.1 finds it and tracks it through the clip." | SAM 3.1 |
| 1:40–2:10 | S4：Vibe 2D 一句話 → 動畫；Vibe 3D 一句話 → 獎盃 | "This is the part I'm most excited about. I describe an effect, and Muse Wonder writes a brand new animation plugin, in 2D or in three.js 3D. It runs in a sandbox and can read the frame, the transcript and what SAM found." | Muse Wonder（Vibe 2D／3D） |
| 2:10–2:25 | S5：3D 場景，打字描述運鏡 → 鏡頭照做 | "3D scenes put my video on a screen in a room. I describe the camera move in plain words, and Muse Spark turns it into keyframes." | Muse Spark 1.3 |
| 2:25–2:45 | S6 快剪：逐字字幕、AI 音效、Re-voice、發佈包縮圖、匯出進度條 | "Karaoke captions, sound effects and music written as code, re-voicing a line in my own voice, a title and a thumbnail from Muse Image, and export. Preview and export use the same compositor, so what I see is what I get." | Muse Image |
| 2:45–3:00 | 原始 vs 成品左右對照 → 架構圖 → 網址 | "From a raw take to a publishable video in minutes, not hours. Try it in your browser, no install needed." | wordblade.zeabur.app · github.com/kevintsai1202/wordblade · 5 Meta models |

## 剪輯要點

- 旁白約 400 個英文字，3 分鐘念得完；每段講不完就砍形容詞，不要加速。
- 螢幕錄影的等待時間（AI 生成、匯出）用 WordBlade 的片段變速加速，角落標「4×」。
- 「原本幾小時、現在幾分鐘」要用真實數字：剪這支 demo 時記下開始與結束時間，填進 2:45 的字卡。
- 配樂用 WordBlade 的 AI 配樂（自己生成，沒有版權問題）；音效同。
- 上傳 YouTube 設「不公開」（unlisted），不要設「私人」；交件前用無痕視窗確認打得開。

## 吉祥物穿插（11/3 定）

- 主角是白色亮面方塊機器人（內建範本 Robot points／Robot points and waves，造型由 WordBlade 內建 3D 吉祥物重寫），站在畫面邊角，不擋內容。
- 鏡頭一律固定（範本 Desk still：木紋桌、螢幕後仰 20 度、佔畫面寬九成），看得到完整畫面，不晃。
- 招牌橋段（Vibe 2D 那段，1:40 前後）：兩段做法，見 `e2e/demo-3d-try-live.spec.ts` 的「兩段版」——
  ① 平面影片上用 Vibe 2D 生成「2D 版的機器人」走進來打招呼 → 匯出；② 匯入成品、套 Desk still 轉立體 → 3D 機器人從另一側走向它、轉身面對面揮手。
- 其他穿插（各 3～5 秒）：開場拍亮畫面、AI 導演清單出現時指著清單、SAM 遮罩完成時點頭、結尾揮手。

## 旁白

- `scripts/tts/demo-narration.mjs`：作者本人聲音克隆、Fish drama-3、15 句語氣提示；`$env:WORDBLADE_VOICE_SEED` 指定樣本資料夾。
