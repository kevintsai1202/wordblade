// 中文逐字稿一律用繁體（開發者 2026-10-31）：Muse ASR 對台灣口音的中文也回簡體，轉錄完依原文判斷要不要轉。
// 有漢字、沒有日文假名 → 用 OpenCC 轉成台灣繁體（cn → twp，含「软件 → 軟體」這類用語）、半形標點轉全形；英文、日文不動。
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

/** 半形 → 全形標點 */
const FULL: Record<string, string> = { ",": "，", "?": "？", "!": "！", ";": "；", ":": "：", ".": "。" };

/**
 * 中文逐字稿的半形標點轉全形（ASR 回「好,」「MVC ?」）：，？！；： 在詞尾（或整個詞就是標點）時轉，夾在數字中間（1,000）不轉；
 * 句號只在漢字後面轉（Node.js、3.5 不動）。
 */
function fullWidthPunct(text: string): string {
  return text.replace(/[,?!;:.](?=$)/u, (p, i: number) => {
    const before = text[i - 1] ?? "";
    if (p === ".") return HAN.test(before) ? FULL[p] : p;
    return FULL[p];
  });
}

/** 中文逐字稿轉台灣繁體、標點轉全形；不是中文（或沒有要改的）回傳原本的陣列 */
export async function toTraditional(words: Word[]): Promise<Word[]> {
  const joined = words.map((w) => w.text).join("");
  if (!HAN.test(joined) || KANA.test(joined)) return words;
  const convert = await loadConverter();
  const all = convert(joined);
  // 依原本每個詞的長度切回去（用語轉換通常不改字數）；長度不同就逐詞轉
  const sameLength = [...all].length === [...joined].length;
  const chars = [...all];
  let pos = 0;
  let changed = false;
  const out = words.map((w) => {
    const n = [...w.text].length;
    const text = fullWidthPunct(sameLength ? chars.slice(pos, pos + n).join("") : convert(w.text));
    pos += n;
    if (text === w.text) return w;
    changed = true;
    return { ...w, text };
  });
  return changed ? out : words;
}
