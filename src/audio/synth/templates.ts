// 內建的音效範本與配樂範例（§5.15）：音效範本不用 AI 就能直接用，也當成模型的例子（scripts/synth/build-prompt.mjs 寫進閘道的提示詞）。
// 資料放在 templateData.json，建置提示詞的腳本（Node）才讀得到同一份。
import data from "./templateData.json";
import type { MusicSpec, SoundSpec } from "./spec";

/** 一個範本 */
export interface SynthTemplate<S> {
  id: string;
  /** 按鈕上的名字 */
  title: string;
  /** 一句說明（也是給模型看的描述） */
  description: string;
  spec: S;
}

/** 內建音效範本（whoosh、pop、ding、打字、上升、下降、點擊、轉場掃頻、撞擊、閃亮） */
export const SOUND_TEMPLATES = data.sound as SynthTemplate<SoundSpec>[];

/** 配樂範例（給模型的例子與測試用） */
export const MUSIC_EXAMPLES = data.music as SynthTemplate<MusicSpec>[];
