// 螢幕文字類個資的定位（開發者 2026-10-28：SAM 3.1 分割不出螢幕上的文字——實測「API key」「text」都 0 個——
// 帳號、密碼、金鑰、Email、電話、證號等改由 Muse Spark 在 1280 寬的畫面上找框；demo 的金鑰 IoU 0.82、每格約 1.2k tokens）。
// 流程：範圍內每秒取 1 格 → 每次最多 8 張送閘道 → 每格的框依「同一列重疊或文字接得上」串成物件（打字時框會變長，IoU 會拆錯）
// → 長方形遮罩，每個取樣涵蓋到下一格的框（打字中不漏字）、離取樣超過 1 秒（消失）就不遮。
import type { MaskObject, MaskSample } from "../core/model";

/** 一格的定位結果（框是 0～1，左上角＋寬高） */
export interface LocateFrame {
  t: number;
  items: { x: number; y: number; w: number; h: number; text: string }[];
}

/** 串好的一個物件的取樣（框是 x1, y1, x2, y2） */
export interface LocateSample {
  t: number;
  box: [number, number, number, number];
  text: string;
}

/** 文字類個資（走 Spark）；其他都是實體物件（走 SAM） */
const TEXT_TARGET = /\b(password|passcode|pin|key|token|secret|credential|email|e-mail|account|username|login|address|number|passport|ssn)s?\b/i;

/** 遮罩目標走哪條路：文字類個資交給 Spark 定位，其他（人、臉、車牌、名牌、卡片實體…）交給 SAM 分割 */
export function targetRoute(phrase: string): "sam" | "spark" {
  return TEXT_TARGET.test(phrase) ? "spark" : "sam";
}

/** 常用目標送給 Spark 的說法（多給同義詞，框比較穩） */
const PROMPTS: Record<string, string> = {
  password: "password or passcode",
  "api key": "API key or secret token",
  "account name": "account name or username",
  username: "account name or username",
  "email address": "email address",
  "phone number": "phone number",
  "id number": "ID or passport number",
};

/** 目標 → 送給 Spark 的說法 */
export function locatePrompt(phrase: string): string {
  return PROMPTS[phrase.trim().toLowerCase()] ?? phrase.trim();
}

/** 隔多久沒看到還算同一個物件（秒） */
const LINK_GAP = 5;
/** 遮罩在取樣之後撐多久（秒）：每秒取 1 格 */
const HOLD = 1;

/** 兩個框在同一列（y 重疊 ≥ 較矮那個的一半）而且 x 有重疊 */
function sameRow(a: [number, number, number, number], b: [number, number, number, number]): number {
  const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const minH = Math.min(a[3] - a[1], b[3] - b[1]);
  return ox > 0 && minH > 0 && oy >= minH * 0.5 ? oy / minH : 0;
}

/** 文字接得上（一個是另一個的開頭或包含在裡面；打字中、捲動時同一串字） */
function sameText(a: string, b: string): boolean {
  const x = a.trim();
  const y = b.trim();
  return x.length >= 3 && y.length >= 3 && (x.startsWith(y) || y.startsWith(x) || x.includes(y) || y.includes(x));
}

/** 各格的框 → 物件（同一列重疊或文字接得上就接；每格每個物件只接一個框；隔太久開新的） */
export function linkBoxes(frames: LocateFrame[]): LocateSample[][] {
  const tracks: LocateSample[][] = [];
  for (const frame of [...frames].sort((a, b) => a.t - b.t)) {
    const used = new Set<LocateSample[]>();
    for (const item of frame.items) {
      const box: [number, number, number, number] = [item.x, item.y, Math.min(1, item.x + item.w), Math.min(1, item.y + item.h)];
      let best: LocateSample[] | null = null;
      let bestScore = 0;
      for (const track of tracks) {
        const last = track[track.length - 1];
        if (used.has(track) || frame.t - last.t > LINK_GAP) continue;
        const score = Math.max(sameRow(last.box, box), sameText(last.text, item.text) ? 0.75 : 0);
        if (score > bestScore) {
          best = track;
          bestScore = score;
        }
      }
      const sample = { t: frame.t, box, text: item.text };
      if (best) {
        best.push(sample);
        used.add(best);
      } else {
        const track = [sample];
        tracks.push(track);
        used.add(track);
      }
    }
  }
  return tracks;
}

/** 物件 → 長方形遮罩：每個取樣的框是這一格與下一格（1.5 秒內）的聯集，打字時後面的字先遮起來 */
export function toRectMasks(tracks: LocateSample[][], opts: { mediaId: string; label: string; idPrefix: string }): MaskObject[] {
  return tracks.map((track, n) => {
    const samples: MaskSample[] = track.map((s, i) => {
      const next = track[i + 1];
      const box: [number, number, number, number] = next && next.t - s.t <= 1.5
        ? [Math.min(s.box[0], next.box[0]), Math.min(s.box[1], next.box[1]), Math.max(s.box[2], next.box[2]), Math.max(s.box[3], next.box[3])]
        : s.box;
      return { t: s.t, box, mask: null };
    });
    return {
      id: `${opts.idPrefix}-${n + 1}`, mediaId: opts.mediaId, prompt: opts.label, label: `${opts.label} ${n + 1}`,
      samples, interval: HOLD, hold: HOLD, effect: { kind: "mosaic", strength: 16 }, expand: 15, enabled: true, shape: "rect",
    };
  });
}

/** 每次最多送幾格 */
const BATCH = 8;

/** 執行參數 */
export interface LocateRunOptions {
  mediaId: string;
  /** 目標（英文名詞片語，例如 password） */
  target: string;
  /** 清單上的名稱 */
  label: string;
  /** 素材時間範圍 */
  start: number;
  end: number;
  /** 取這些素材時間的畫面（寬 1280 的 JPEG） */
  grab: (times: number[]) => Promise<Uint8Array[]>;
  api: { locate(target: string, frames: { t: number; jpeg: Uint8Array }[]): Promise<LocateFrame[]> };
  onProgress?: (p: { done: number; total: number }) => void;
  signal?: AbortSignal;
}

/** 執行一次：取樣 → 送 Spark → 遮罩物件 */
export async function runLocate(opts: LocateRunOptions): Promise<{ objects: MaskObject[]; frames: number }> {
  const times: number[] = [];
  for (let t = opts.start; t <= opts.end + 1e-6; t += 1) times.push(Math.round(t * 1000) / 1000);
  const results: LocateFrame[] = [];
  for (let i = 0; i < times.length; i += BATCH) {
    if (opts.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const batch = times.slice(i, i + BATCH);
    const jpegs = await opts.grab(batch);
    results.push(...(await opts.api.locate(locatePrompt(opts.target), batch.map((t, k) => ({ t, jpeg: jpegs[k] })))));
    opts.onProgress?.({ done: Math.min(times.length, i + BATCH), total: times.length });
  }
  const objects = toRectMasks(linkBoxes(results), { mediaId: opts.mediaId, label: opts.label, idPrefix: `text-${crypto.randomUUID().slice(0, 8)}` });
  return { objects, frames: times.length };
}
