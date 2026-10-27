// 字幕圖層（spec §5.4、§5.18，D37）：用 Canvas 2D 把目前的字幕畫在一張透明的 OffscreenCanvas 上，交給合成器疊在最上層。
// 預覽（PreviewPlayer）與匯出（exporter）用同一個類別，畫出來一樣。字型 Inter／Noto Sans TC 由 main.tsx 載入 @font-face；
// Canvas 不會自己觸發 unicode-range 分塊的下載，所以畫之前先 document.fonts.load 這段文字（預覽：還沒載好先用備用字型、載好再重畫；
// 匯出：開始前全部載好）。
import type { Caption, TimelineWord } from "../core/captions";
import type { Seconds } from "../core/model";
import { captionAt, captionFont, captionLayout, wordStates, type CaptionStyle, type WordState } from "./captionLayout";

/** 量字用的字高（排版的量寬與字高成正比，用固定字高量再換算） */
const MEASURE_PX = 100;

/** 某段字幕裡每個詞的時間（同一個詞 id 在時間軸上出現兩次時，取落在這段字幕裡的那個） */
function timesFor(caption: Caption, words: TimelineWord[]): Map<string, { start: Seconds; end: Seconds }> {
  const ids = new Set(caption.wordIds);
  const map = new Map<string, { start: Seconds; end: Seconds }>();
  for (const w of words) {
    if (ids.has(w.id) && w.start >= caption.start - 0.01 && w.start < caption.end && !map.has(w.id)) map.set(w.id, { start: w.start, end: w.end });
  }
  return map;
}

/** 等這段文字要用的字型載好（中文字型分塊，用到的才下載） */
export async function loadCaptionFonts(texts: string[]): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  // 文字併成幾大段一起載，減少呼叫次數
  const all = [...new Set(texts.join(" "))].join("");
  for (let i = 0; i < all.length; i += 2000) await document.fonts.load(captionFont(MEASURE_PX), all.slice(i, i + 2000)).catch(() => undefined);
}

/** 字幕圖層 */
export class CaptionLayer {
  private canvas: OffscreenCanvas;
  private readonly ctx: OffscreenCanvasRenderingContext2D;
  /** 上一次畫的內容鍵（沒變就直接回傳同一張） */
  private key = "";
  /** 已經要求載入過的文字（避免重複觸發） */
  private readonly requested = new Set<string>();

  /** onFontsLoaded：預覽時字型載好要重畫（匯出不需要，先 loadCaptionFonts） */
  constructor(width: number, height: number, private readonly onFontsLoaded: (() => void) | null = null) {
    this.canvas = new OffscreenCanvas(width, height);
    this.ctx = this.canvas.getContext("2d")!;
  }

  /** 量文字寬（px 字高） */
  private measure = (text: string, px: number): number => {
    this.ctx.font = captionFont(MEASURE_PX);
    return (this.ctx.measureText(text).width * px) / MEASURE_PX;
  };

  /** 時間 t 的字幕畫好回傳；這時沒有字幕（或樣式是 none）回 null */
  render(captions: Caption[], words: TimelineWord[], t: Seconds, style: CaptionStyle, width: number, height: number): OffscreenCanvas | null {
    if (style.preset === "none") return null;
    const caption = captionAt(captions, t);
    if (!caption) return null;
    const text = caption.lines.join(" ");
    this.ensureFont(text);
    const states = style.karaoke === "off" ? {} : wordStates(caption, timesFor(caption, words), t);
    const key = `${caption.id}|${caption.start}|${text}|${JSON.stringify(states)}|${JSON.stringify(style)}|${width}x${height}|${this.requested.size}`;
    if (key === this.key) return this.canvas;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.key = key;
    this.ctx.clearRect(0, 0, width, height);
    draw(this.ctx, caption, width, height, style, states, this.measure);
    return this.canvas;
  }

  /** 字型還沒載好就要求載入，載好後通知重畫 */
  private ensureFont(text: string) {
    if (typeof document === "undefined" || !document.fonts || this.requested.has(text)) return;
    if (document.fonts.check(captionFont(MEASURE_PX), text)) return;
    this.requested.add(text);
    void document.fonts.load(captionFont(MEASURE_PX), text).then(() => {
      this.key = "";
      this.onFontsLoaded?.();
    }, () => undefined);
  }
}

/** 畫一段字幕（三種外觀＋逐字高亮） */
function draw(ctx: OffscreenCanvasRenderingContext2D, caption: Caption, width: number, height: number, style: CaptionStyle, states: Record<string, WordState>, measure: (text: string, px: number) => number) {
  const layout = captionLayout(caption, width, height, style, measure);
  const px = layout.fontPx;
  ctx.font = captionFont(px);
  ctx.textBaseline = "alphabetic";
  ctx.lineJoin = "round";
  // 底色塊：每行一塊
  if (style.preset === "box") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.62)";
    for (const line of layout.lines) ctx.fillRect(line.x - px * 0.35, line.baseline - px * 0.98, line.width + px * 0.7, px * 1.3);
  }
  for (const line of layout.lines) {
    for (const w of line.words) {
      const state = states[w.id] ?? "future";
      const lit = (style.karaoke === "fill" && state !== "future") || (style.karaoke !== "off" && style.karaoke !== "fill" && state === "active" && style.karaoke !== "scale");
      // 講到的詞加底色
      if (style.karaoke === "box" && state === "active") {
        ctx.fillStyle = style.highlight;
        ctx.fillRect(w.x - px * 0.12, line.baseline - px * 0.92, w.width + px * 0.24, px * 1.18);
      }
      ctx.save();
      // 講到的詞放大（以詞的中心為準）
      if (style.karaoke === "scale" && state === "active") {
        const cx = w.x + w.width / 2;
        const cy = line.baseline - px * 0.35;
        ctx.translate(cx, cy);
        ctx.scale(1.18, 1.18);
        ctx.translate(-cx, -cy);
      }
      if (style.preset === "shadow") {
        ctx.shadowColor = "rgba(0, 0, 0, 0.85)";
        ctx.shadowBlur = px * 0.25;
        ctx.shadowOffsetY = px * 0.06;
      }
      if (style.preset === "outline") {
        ctx.strokeStyle = "rgba(0, 0, 0, 0.9)";
        ctx.lineWidth = px * 0.14;
        ctx.strokeText(w.text, w.x, line.baseline);
      }
      // 底色模式的字用深色，其他模式的高亮用 highlight
      ctx.fillStyle = style.karaoke === "box" && state === "active" ? "#111111" : lit || (style.karaoke === "scale" && state === "active") ? style.highlight : style.color;
      ctx.fillText(w.text, w.x, line.baseline);
      ctx.restore();
    }
  }
}
