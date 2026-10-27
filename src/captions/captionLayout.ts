// 燒進畫面的字幕（spec §5.4、§5.18，D37：自己用 Canvas 2D 畫，取代 JASSUB）：純函式的排版與逐字高亮狀態，Vitest 測。
// 斷行已由 buildCaptions 決定（每行最多 42 字元、最多 2 行）；這裡只量每個詞的寬、置中、算位置，必要時整體縮小塞進畫面。
import type { Caption } from "../core/captions";
import type { Seconds } from "../core/model";

/** 字幕樣式（存在 Project.captionStyle；沒設就用 DEFAULT_CAPTION_STYLE） */
export interface CaptionStyle {
  /** 外觀：描邊／底色塊／陰影；none＝不燒進畫面（只輸出 SRT） */
  preset: "outline" | "box" | "shadow" | "none";
  /** 字高（畫面高的比例） */
  size: number;
  /** 最後一行基線離畫面底的距離（畫面高的比例） */
  bottom: number;
  /** 字的顏色 */
  color: string;
  /** 逐字高亮：off／fill（講過的與講到的上色）／scale（講到的放大）／box（講到的加底色） */
  karaoke: "off" | "fill" | "scale" | "box";
  /** 高亮的顏色 */
  highlight: string;
}

/** 預設樣式：白字黑描邊、字高 5.5%、離底 8% */
export const DEFAULT_CAPTION_STYLE: CaptionStyle = { preset: "outline", size: 0.055, bottom: 0.08, color: "#ffffff", karaoke: "off", highlight: "#ffd400" };

/** 字幕用的字型：英文 Inter、中文 Noto Sans TC（都隨程式打包，D37） */
export const CAPTION_FONT_FAMILY = "Inter, 'Noto Sans TC', sans-serif";
/** 字重 */
export const CAPTION_FONT_WEIGHT = 700;

/** Canvas 的 font 字串 */
export function captionFont(px: number): string {
  return `${CAPTION_FONT_WEIGHT} ${px}px ${CAPTION_FONT_FAMILY}`;
}

/** 排好的一個詞 */
export interface LaidWord {
  id: string;
  text: string;
  /** 左邊的 x（像素） */
  x: number;
  width: number;
}

/** 排好的一行 */
export interface LaidLine {
  /** 整行左邊的 x 與寬 */
  x: number;
  width: number;
  /** 基線的 y */
  baseline: number;
  words: LaidWord[];
}

/** 一段字幕的排版 */
export interface CaptionLayout {
  fontPx: number;
  lines: LaidLine[];
}

/** 最寬的一行最多佔畫面寬的比例 */
const MAX_WIDTH = 0.9;
/** 行距（字高的倍數） */
const LINE_HEIGHT = 1.25;

/** 時間 t 的字幕（起點含、終點不含） */
export function captionAt(captions: Caption[], t: Seconds): Caption | null {
  return captions.find((c) => t >= c.start && t < c.end) ?? null;
}

/**
 * 排版：每行的詞依序排、詞間一個空白、整行水平置中；最後一行基線在離底 bottom 處，其他行往上疊。
 * measure(text, px)：用該字高量文字寬（Canvas measureText；測試注入假的）。
 */
export function captionLayout(caption: Caption, width: number, height: number, style: CaptionStyle, measure: (text: string, px: number) => number): CaptionLayout {
  let px = Math.max(8, Math.round(height * style.size));
  // 量寬是字高的線性函數：先用目前字高量，太寬就等比縮小
  const lineWidth = (ids: string[], words: string[], size: number) => words.reduce((w, t) => w + measure(t, size), 0) + measure(" ", size) * Math.max(0, ids.length - 1);
  const wordsOf = (i: number) => caption.lines[i].split(" ").filter(Boolean);
  const widest = Math.max(1, ...caption.lineWordIds.map((ids, i) => lineWidth(ids, wordsOf(i), px)));
  if (widest > width * MAX_WIDTH) px = Math.max(8, Math.floor((px * width * MAX_WIDTH) / widest));
  const space = measure(" ", px);
  const n = caption.lines.length;
  const lines = caption.lines.map((_, i) => {
    const texts = wordsOf(i);
    const ids = caption.lineWordIds[i] ?? texts.map((_, k) => `${caption.id}#${i}.${k}`);
    const total = lineWidth(ids, texts, px);
    let x = (width - total) / 2;
    const words = texts.map((text, k) => {
      const w = measure(text, px);
      const laid = { id: ids[k] ?? `${caption.id}#${i}.${k}`, text, x, width: w };
      x += w + space;
      return laid;
    });
    return { x: (width - total) / 2, width: total, baseline: height * (1 - style.bottom) - (n - 1 - i) * px * LINE_HEIGHT, words };
  });
  return { fontPx: px, lines };
}

/** 一個詞的高亮狀態 */
export type WordState = "past" | "active" | "future";

/**
 * 逐字高亮：時間 t 時字幕裡每個詞的狀態。講到的（最後一個已開始的詞）是 active，之前的 past、之後的 future；
 * 詞與詞之間的空檔維持上一個詞；最後一個詞講完後（字幕為了閱讀延長顯示的那段）全部 past。
 */
export function wordStates(caption: Caption, times: Map<string, { start: Seconds; end: Seconds }>, t: Seconds): Record<string, WordState> {
  const ids = caption.lineWordIds.flat();
  const out: Record<string, WordState> = {};
  const lastEnd = Math.max(...ids.map((id) => times.get(id)?.end ?? -Infinity));
  let active = -1;
  ids.forEach((id, i) => { if ((times.get(id)?.start ?? Infinity) <= t) active = i; });
  ids.forEach((id, i) => {
    out[id] = t >= lastEnd ? "past" : i < active ? "past" : i === active ? "active" : "future";
  });
  return out;
}
