// 影片縮圖（spec §5.12、§5.17）：底圖（播放頭這一格，或 Muse Image 改過的）cover 到 1280×720，
// 底部加漸層，疊上選中的標題（粗體白字、黑描邊，最多 2 行、放不下就縮字）。字一律由這裡畫，不交給模型（模型會拼錯）。
// 版面計算是純函式（可測）；真正畫圖用 OffscreenCanvas。

/** 縮圖尺寸 */
export const THUMB_W = 1280;
export const THUMB_H = 720;

/** 量字寬：(文字, 字級) → 像素 */
export type Measure = (text: string, size: number) => number;

/** 中日韓文字（沒有空白，逐字斷行） */
const CJK = /[぀-ヿ㐀-鿿豈-﫿가-힯]/;

/** 斷行單位：拉丁文以空白分詞（詞後面接空白），中日韓逐字 */
function tokens(text: string): string[] {
  const out: string[] = [];
  let word = "";
  for (const c of text) {
    if (CJK.test(c)) {
      if (word) out.push(word);
      word = "";
      out.push(c);
    } else if (c === " ") {
      if (word) out.push(`${word} `);
      word = "";
    } else {
      word += c;
    }
  }
  if (word) out.push(word);
  return out;
}

/** 依寬度把 tokens 排成行（貪婪）；回傳每行文字 */
function wrap(parts: string[], size: number, maxWidth: number, measure: Measure): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const p of parts) {
    const next = cur + p;
    if (cur && measure(next.trimEnd(), size) > maxWidth) {
      lines.push(cur.trimEnd());
      cur = p;
    } else {
      cur = next;
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd());
  return lines;
}

/**
 * 標題版面：從最大字級往下試，找最多 2 行、每行都放得下的字級；
 * 到最小字級還放不下就用最小字級，第二行截斷加「…」。
 */
export function layoutTitle(title: string, measure: Measure, maxWidth: number, sizes: { max: number; min: number }): { size: number; lines: string[] } {
  const parts = tokens(title.trim());
  for (let size = sizes.max; size >= sizes.min; size -= 2) {
    const lines = wrap(parts, size, maxWidth, measure);
    if (lines.length <= 2 && lines.every((l) => measure(l, size) <= maxWidth)) return { size, lines };
  }
  const size = sizes.min;
  const lines = wrap(parts, size, maxWidth, measure);
  if (lines.length <= 2) return { size, lines };
  // 第二行接上後面全部，再從尾巴截到放得下「…」
  let second = lines.slice(1).join(" ");
  while (second && measure(`${second}…`, size) > maxWidth) second = [...second].slice(0, -1).join("");
  return { size, lines: [lines[0], `${second.trimEnd()}…`] };
}

/** cover：來源圖要取哪一塊，才能鋪滿 w×h 不變形 */
export function coverRect(srcW: number, srcH: number, w: number, h: number): { sx: number; sy: number; sw: number; sh: number } {
  const scale = Math.max(w / srcW, h / srcH);
  const sw = w / scale;
  const sh = h / scale;
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

/** 標題字型 */
const FONT = (size: number) => `900 ${size}px "Segoe UI", "Microsoft JhengHei", "PingFang TC", "Helvetica Neue", Arial, sans-serif`;

/** 合成縮圖：底圖 cover、底部漸層、標題（左下，粗體白字黑描邊）→ 1280×720 PNG */
export async function composeThumbnail(base: ImageBitmap, title: string): Promise<Blob> {
  const canvas = new OffscreenCanvas(THUMB_W, THUMB_H);
  const g = canvas.getContext("2d")!;
  const r = coverRect(base.width, base.height, THUMB_W, THUMB_H);
  g.drawImage(base, r.sx, r.sy, r.sw, r.sh, 0, 0, THUMB_W, THUMB_H);
  // 底部 55% 漸層壓暗，字才清楚
  const grad = g.createLinearGradient(0, THUMB_H * 0.45, 0, THUMB_H);
  grad.addColorStop(0, "rgba(0,0,0,0)");
  grad.addColorStop(1, "rgba(0,0,0,0.78)");
  g.fillStyle = grad;
  g.fillRect(0, THUMB_H * 0.45, THUMB_W, THUMB_H * 0.55);
  if (title.trim()) {
    const margin = 64;
    const measure: Measure = (text, size) => {
      g.font = FONT(size);
      return g.measureText(text).width;
    };
    const { size, lines } = layoutTitle(title, measure, THUMB_W - margin * 2, { max: 112, min: 52 });
    g.font = FONT(size);
    g.textBaseline = "alphabetic";
    g.lineJoin = "round";
    const lineH = size * 1.12;
    let y = THUMB_H - margin - lineH * (lines.length - 1);
    for (const line of lines) {
      g.lineWidth = size * 0.16;
      g.strokeStyle = "rgba(0,0,0,0.9)";
      g.strokeText(line, margin, y);
      g.fillStyle = "#ffffff";
      g.fillText(line, margin, y);
      y += lineH;
    }
  }
  return canvas.convertToBlob({ type: "image/png" });
}
