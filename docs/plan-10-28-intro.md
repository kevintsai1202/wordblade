# 10/28 一鍵片頭：翻頁式（P1-12，spec §5.23、D34）

開發者 2026-10-28 決定：先片頭、再發佈包；§5.23 待決定 1～4 全照建議（圖片解碼成 ImageBitmap 進沙盒、每個音效 cue 一個 A3 片段共用一個 Synth 的 WAV、V1 放內建黑色素材、雙色調在 shader 做）；音效 spec 加隨機振幅調變；沒有自己的音樂時用內建配樂範本。
參數與節奏取自 `docs/research/intro-styles.md` §1.4、§3.4（brand-v2 短版）。

## 範圍

- 第一版只做「翻頁式」一種風格；之後的風格（節拍切圖、Ken Burns、格狀拼貼…）不在這輪。
- 配樂：內建配樂範本（固定 BPM，揭曉落在小節頭）或不要配樂。**使用者自己的音樂＋BPM／重拍偵測放到 I6**，時間不夠就砍。
- 字型：Worker 裡用系統字（`sans-serif` 粗體），不載 FontFace（§4 缺口 7 之後再驗）。

## 設計

```
IntroRequest ──flipIntro()──► IntroPlan { duration, cues[], effect params, sounds[{synthKey,t,gain}], music? }
                 （純函式，Vitest）          │
                                            ▼
                 applyIntro(project, plan, ids) ── 一次 commit：V1 漣漪插入黑色素材、加 scene3d 特效、A3 每聲一片段、A2 配樂片段
```

- `src/intro/flip.ts`：cue 表（以 `reveal` 為錨點：`climax = reveal − 0.5`，翻頁從 `montageStart` 起 `gap0` 每頁乘 `ratio`、最短 2 格；`flash = climax − 0.04`；`riserStart = climax − 2`），每頁 `strength = 1 − 0.45 × 速度比`。同一個 `seed` 洗牌結果相同。
- `src/intro/sounds.ts`：翻頁（慢 0.32 秒／快 0.12 秒兩版）、riser、impact 三種 `SoundSpec`；內建配樂 `MusicSpec`（120 BPM 4/4，前 2 小節墊音＋上升琶音，第 3 小節第一拍鼓組與貝斯進＝揭曉 4.0 秒）。
- 音效 spec 加 `am: { rate, depth }`（隨機振幅調變：每 1/rate 秒一個隨機值、平滑），schema、驗證、render、閘道的 schema 複本一起改。
- 3D 插件 `src/three/builtins/flipIntro.js`：每頁一個上緣為軸的平面（`rotation.x` −105°→0°），相機推近；雙色調 `ShaderMaterial`；閃光全畫面平面；標題用 OffscreenCanvas 畫字、揭曉前字內輪流透出封面（`source-in`）、揭曉轉白字＋1.04 彈跳；icon 彈入。
- 圖片進沙盒：`Effect.params.imageIds` → 主程式把圖片素材解碼成 `ImageBitmap`（寬 ≤ 1280；軟體算繪第一格要上傳 16 張貼圖，太大會逾時）→ ThreeHost 建 Worker 後送一次 `images`（複製後轉移）→ harness 放 `env.images`。預覽與匯出同一條路。
- 套用：`core/timeline.ts` 加 `insertIntro`（重用私有的 `rippleInsertDraft`；同時把插件登記進 `project.plugins`，同 `addEffect`），history 加 `insertIntro` 編輯（素材 id 由介面先匯入：黑色 PNG（網頁版 probe 圖片走不通就改用第一張封面當 V1 佔位，scene3d 會整個蓋住）、三種音效 WAV、配樂 WAV 都走 `engine.importGenerated` → 一般匯入），一次 Ctrl+Z 復原。
- 介面：Effects 大類別下加子頁籤「Intro」：選圖（素材庫裡的圖片，勾選）、標題、副標、icon、配樂（內建／不要）、seed、「Generate intro」。

## 任務

順序（advisor 建議，截止 11/4）：I1 → I3 → I4 → I5 → I2（am 最後）→ I6 砍。畫面先，沒有聲音的片頭也能 demo。

| # | 任務 | 驗收 |
| --- | --- | --- |
| I1 | `intro/flip.ts`：cue 表與計畫（純函式） | Vitest：brand-v2 短版的逐頁時間（gap0 0.26、0.9 起 16 頁到 2.68、第 10 頁起 2 格）、reveal 3.2（無配樂）與 4.0（內建配樂 2 小節）、最短 2 格、圖片不足循環＋warning、同 seed 同結果 |
| I2 | 音效 spec 加 `am`；翻頁／riser／impact 與內建配樂 spec | Vitest：驗證通過、render 有聲音、am 讓包絡起伏；閘道 schema 同步測試 |
| I3 | 圖片進 3D 沙盒（`env.images`）＋翻頁插件 | e2e：片頭區段畫得出東西、揭曉時標題區域是白字 |
| I4 | `insertIntro` 編輯：V1 漣漪插入、特效、A3／A2 片段，一次復原 | Vitest |
| I5 | Intro 子頁籤，一鍵產生並插入 | e2e：產生後時間軸開頭有片頭、Ctrl+Z 一次復原 |
| I6 | 使用者音樂：BPM／重拍偵測（`web-audio-beat-detector`＋移植重拍評分） | 之後；時間不夠就砍 |

## 進度

| # | 狀態 | 結果 |
| --- | --- | --- |
| I1 | 未做 | |
| I2 | 未做 | |
| I3 | 未做 | |
| I4 | 未做 | |
| I5 | 未做 | |
| I6 | 未做 | |
