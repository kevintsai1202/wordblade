// 中文逐字稿一律用繁體（開發者 2026-10-31）：Muse ASR 對台灣口音的中文也回簡體，轉錄完依原文判斷要不要轉。
// 有漢字、沒有日文假名 → 用 OpenCC 轉成台灣繁體（cn → twp，含「软件 → 軟體」這類用語）；英文、日文不動。
// 用語可能跨詞（Muse 的中文詞常是一兩個字），所以整串接起來轉、再依原本每個詞的長度切回去；長度變了就退回逐詞轉。
import type { Word } from "../core/model";

/** 漢字 */
const HAN = /\p{Script=Han}/u;
/** 日文假名（有就當日文，不轉） */
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

/** 轉換器（第一次用到才載入字典，約幾百 KB） */
let converter: Promise<(text: string) => string> | null = null;
const loadConverter = () => {
  converter ??= import("opencc-js/cn2t").then((o) => o.Converter({ from: "cn", to: "twp" }));
  return converter;
};

/** 中文逐字稿轉台灣繁體；不是中文（或沒有要轉的）回傳原本的陣列 */
export async function toTraditional(words: Word[]): Promise<Word[]> {
  const joined = words.map((w) => w.text).join("");
  if (!HAN.test(joined) || KANA.test(joined)) return words;
  const convert = await loadConverter();
  const all = convert(joined);
  if (all === joined) return words;
  // 依原本每個詞的長度切回去（用語轉換通常不改字數）；長度不同就逐詞轉
  const sameLength = [...all].length === [...joined].length;
  const chars = [...all];
  let pos = 0;
  return words.map((w) => {
    const n = [...w.text].length;
    const text = sameLength ? chars.slice(pos, pos + n).join("") : convert(w.text);
    pos += n;
    return text === w.text ? w : { ...w, text };
  });
}
