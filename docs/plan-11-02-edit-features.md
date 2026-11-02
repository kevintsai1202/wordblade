# 11/2 剪輯功能一次做完：轉場、定格、色彩、2D 圖片填色、卡拉 OK 重配錄音

開發者確認（2026-11-02）：轉場不影響長度；色彩預設整條，可依選取的時間軸範圍調；其餘照預設。

**狀態（11/2）：五項都做完了。** 單元測試 729 個全過，`e2e/edit-features.spec.ts` 3 個通過，相關 spec（layout、revoice、export、recording、effects、speed、preview、textures、mask、zoom）共 23 個通過。
匯出實測：穿白轉場的接點是全白；定格 5～7 秒內兩格相同；色彩調整範圍內平均亮度 67、範圍外 123。
還沒人工看過：轉場與推移的實際觀感、真麥克風錄的卡拉 OK、金屬字等材質填色的效果。
已知限制：色彩滑桿拖動時預覽不會即時更新，放開才套用；卡拉 OK 錄音時不播放影片（只有提詞器），也不接 Windows 錄音機退路。

## 1. 轉場（§5.9，P2）

- 資料：`Project.transitions?: { id, clipId, kind, duration }[]`。`clipId` 是 V1 上「後面那段」，轉場放在它的起點（和前一段的接點 T）。
- 不改長度：轉場時間窗 `[T − d/2, T + d/2]`。前一段在 T 之後繼續播（素材時間照速度往後延，超出素材長度就停在最後一格）；後一段在 T 之前提早出現（往前延，小於 0 就停在第一格）。
- 種類：`dissolve`（溶接）、`dipBlack`、`dipWhite`（穿黑／白：前半段前一段淡出到純色、後半段後一段淡入）、`pushLeft`、`pushRight`（推移：兩段一起平移）。推近不做。
- 長度預設 0.5 秒，限 0.1～2 秒，且不超過兩側片段長度的一半。
- 實作：`src/core/transitions.ts` 純函式算「t 時兩段各自的素材時間、透明度、位移、底色」；`framePlan` 用它產生 V1 圖層（純色用 `solid` 圖層）；匯出 `clipFrames` 依延伸後的範圍解格。預覽與匯出共用。
- 剪輯後找不到接點（前一段被刪、片段被移走）的轉場不畫，Inspector 可刪。
- UI：V1 接點上按右鍵或在 Inspector 選片段 → Transition 下拉（None／種類）＋長度。

## 2. 定格（§5.20，P2）

- `Clip.freeze` 已有。新增 `insertFreeze(project, t, hold=2)`：在播放頭切開 V1 片段，中間插一段定格片段（同素材、`freeze.at`＝該格素材時間），漣漪插入 hold 秒（其他未鎖定的軌一起往後推，所以對白軌在定格期間是空的＝無聲）。
- UI：時間軸工具列「Freeze」按鈕、快捷鍵 Shift+F。

## 3. 色彩調整（P3）

- 資料：`Project.colorGrades?: { id, start, end, brightness, contrast, saturation, temperature }[]`（時間軸時間，值 −1～1，0 是不變）。
- 預設整條：沒選範圍時新增的範圍是 0～專案結尾；有選範圍就用選取範圍。重疊時後加的蓋前面的（不疊加）。
- 套用：所有影像圖層畫上去時在 shader 裡調（只調影片／圖片，特效、字幕不調）。預覽、匯出共用。
- 漣漪刪除與插入時範圍跟著移（和特效一樣）。
- UI：Effects → Color 子頁籤：四個滑桿、Reset、清單。

## 4. 2D 插件用圖片填色

- 2D 圖層新增 `fill: { textureId, color: <素材 id>, repeat, mix }`。runtime（`anim_runtime.js`）在圖層畫好後用 `source-atop` 把材質圖平鋪蓋上去（保留形狀，mix 0～1 是蓋多少），所以任何 2D 插件都能用，不用插件配合。
- 圖片由主程式解好隨 render 請求送進沙盒（`textures: ImageBitmap[]`，fill 改寫成索引）。
- UI：2D 圖層的 Inspector 加 Fill 下拉（材質庫的材質）＋平鋪、強度。

## 5. P1-9 卡拉 OK 重配錄音

- Re-voice 分頁加「● Record」：倒數 3 秒 → 開始錄、提詞器依原本的詞時間逐字高亮（文字改過就平均分配）→ 到範圍長度自動停（也可手動停）。
- 錄好的 WAV 進素材庫，照 AI 重配音一樣放到 Voice 軌、範圍內原聲靜音、可切回原聲（`Voiceover.source = "recorded"`）。
- 只用 getUserMedia；失敗就顯示錯誤（不接 Windows 錄音機退路，那個沒辦法對時）。不送 Fish，不需要同意說明。

## 測試

- 單元：transitions、freeze、colorGrades（含漣漪）、framePlan／clipFrames 的轉場、runtime 的 fill、karaoke 提詞時間。
- e2e：新寫 `e2e/edit-features.spec.ts`（加轉場、定格、色彩、填色、錄音用假麥克風），加跑 timeline、export、revoice 相關 spec。
