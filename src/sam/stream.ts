// SAM 3.1 逐格輸出的解析（spec §5.3）：照搬 transcript-review/backend/face_track.py 的 SamStream（保留遮罩模式）。
// 格式（dev.meta.ai「Reading segmentation output」）：一格一行，<N f> 開頭，記錄以逗號分隔；
// 記錄是 id<|box;x1=…;y1=…;x2=…;y2=…;w=…;h=…|><|mask;x=0;y=0;data=H,W,編碼內容|>（沒有遮罩的記錄也接受）。
// 遮罩內容的字元集不含 | < > 、逗號與換行，但仍要求「|>」後面接逗號、換行或文字結束才算遮罩結尾（字元集萬一改了也不會切錯）。
// 2026-10-28 實測（scripts/sam/probe.mjs）：一格一個 delta、每格以換行結尾；遮罩尺寸 = 框的寬高 + 1。

/** 一筆記錄的遮罩：相對框左上角的偏移、點陣高寬、編碼內容 */
export interface SamMaskField {
  x: number;
  y: number;
  h: number;
  w: number;
  payload: string;
}

/** 一筆記錄：SAM 物件 id、框（小檔像素）、小檔寬高、遮罩（沒有就 null） */
export interface SamRecord {
  id: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  w: number;
  h: number;
  mask: SamMaskField | null;
}

/** 一格：小檔的影格序號與記錄 */
export interface SamFrame {
  frame: number;
  records: SamRecord[];
}

const FRAME = /^<(\d+)f>/;
const BOX = /^(\d+)<\|box;([^|>]*)\|>/;
/** 緩衝區結尾可能是還沒收完的影格標記 */
const FRAME_PREFIX = /^<\d*f?$/;
/** 記錄還沒收完（id 或 box 只收到一半） */
const BOX_PREFIX = /^\d+(<(\|(b(o(x(;[^|>]*(\|)?)?)?)?)?)?)?$/;
const MASK_OPEN = "<|mask;";

/** 欄位字串 a=1;b=2 → 物件（每個欄位只在第一個等號切開：遮罩內容可能有等號） */
function fields(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(";")) {
    if (!part) continue;
    const i = part.indexOf("=");
    if (i < 0) throw new Error("SAM output: bad field");
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** box 欄位 → 數字 */
function boxFields(text: string): Omit<SamRecord, "id" | "mask"> {
  const f = fields(text);
  const num = (k: string) => {
    const v = Math.round(Number(f[k]));
    if (f[k] === undefined || !Number.isFinite(v)) throw new Error("SAM output: bad box");
    return v;
  };
  return { x1: num("x1"), y1: num("y1"), x2: num("x2"), y2: num("y2"), w: num("w"), h: num("h") };
}

/** mask 欄位 x=…;y=…;data=H,W,內容（c= 這類欄位略過）→ 遮罩 */
function maskFields(text: string): SamMaskField {
  const f = fields(text);
  if (f.data === undefined) throw new Error("SAM output: mask without data");
  const a = f.data.indexOf(",");
  const b = a < 0 ? -1 : f.data.indexOf(",", a + 1);
  if (b < 0) throw new Error("SAM output: bad mask data");
  const h = Number(f.data.slice(0, a));
  const w = Number(f.data.slice(a + 1, b));
  const x = Number(f.x ?? 0);
  const y = Number(f.y ?? 0);
  if (![h, w, x, y].every(Number.isInteger)) throw new Error("SAM output: bad mask data");
  return { x, y, h, w, payload: f.data.slice(b + 1) };
}

/** SAM 逐格輸出的串流解析器：feed(文字片段) 回傳這次收完整的影格，close() 收尾 */
export class SamStream {
  /** 還沒處理的文字 */
  private buf = "";
  /** 目前這一格的序號 */
  private frame: number | null = null;
  /** 目前這一格已收完的記錄 */
  private records: SamRecord[] = [];
  /** 正在讀遮罩內容（buf 從遮罩內容的開頭算起） */
  private inMask = false;
  /** 遮罩內容已找過結尾的位置（長內容不重複掃描） */
  private scan = 0;
  /** 這次 feed 收完整的影格 */
  private out: SamFrame[] = [];

  /** 目前這一格收完：有記錄就輸出 */
  private emit() {
    if (this.frame !== null && this.records.length) this.out.push({ frame: this.frame, records: this.records });
    this.frame = null;
    this.records = [];
  }

  /** 遮罩在 buf 第 k 個字結束：補到最後一筆記錄上，buf 移到結尾之後 */
  private endMask(k: number, rest: string) {
    this.records[this.records.length - 1].mask = maskFields(this.buf.slice(0, k));
    this.buf = rest;
    this.inMask = false;
    this.scan = 0;
  }

  /** 在遮罩內容裡找結尾；找到回 true，內容還沒收完回 false */
  private skipMask(final: boolean): boolean {
    for (;;) {
      const k = this.buf.indexOf("|>", this.scan);
      if (k < 0) {
        this.scan = Math.max(0, this.buf.length - 1);
        return false;
      }
      const rest = this.buf.slice(k + 2);
      if (!rest) {
        if (final) {
          this.endMask(k, "");
          return true;
        }
        this.scan = k;
        return false;
      }
      if (",\r\n".includes(rest[0])) {
        this.endMask(k, rest);
        return true;
      }
      this.scan = k + 1; // 遮罩內容裡的「|>」
    }
  }

  /** 盡量處理緩衝區；final 時把結尾當成文字結束 */
  private parse(final: boolean) {
    for (;;) {
      if (this.inMask && !this.skipMask(final)) return;
      const s = this.buf.replace(/^[ \t]+/, "");
      this.buf = s;
      if (!s) return;
      const c = s[0];
      if (c === "\r" || c === "\n") {
        this.emit();
        this.buf = s.slice(1);
        continue;
      }
      if (c === ",") {
        this.buf = s.slice(1);
        continue;
      }
      if (c === "<") {
        const m = FRAME.exec(s);
        if (m) {
          this.emit();
          this.frame = Number(m[1]);
          this.buf = s.slice(m[0].length);
          continue;
        }
        if (!final && FRAME_PREFIX.test(s)) return;
        throw new Error("SAM output: parse failed");
      }
      if (c >= "0" && c <= "9") {
        const m = BOX.exec(s);
        if (!m) {
          if (!final && BOX_PREFIX.test(s)) return; // 記錄還沒收完
          throw new Error("SAM output: parse failed");
        }
        const rest = s.slice(m[0].length);
        if (!final && rest.length < MASK_OPEN.length && MASK_OPEN.startsWith(rest)) return; // 還不知道後面有沒有遮罩
        if (this.frame === null) throw new Error("SAM output: record before frame mark");
        this.records.push({ id: Number(m[1]), ...boxFields(m[2]), mask: null });
        if (rest.startsWith(MASK_OPEN)) {
          this.buf = rest.slice(MASK_OPEN.length);
          this.inMask = true;
          this.scan = 0;
        } else {
          this.buf = rest;
        }
        continue;
      }
      throw new Error("SAM output: parse failed");
    }
  }

  /** 收一段文字，回傳這次收完整的影格 */
  feed(text: string): SamFrame[] {
    this.buf += text;
    this.out = [];
    this.parse(false);
    return this.out;
  }

  /** 文字結束：處理剩下的內容、輸出最後一格 */
  close(): SamFrame[] {
    this.out = [];
    this.parse(true);
    if (this.inMask) throw new Error("SAM output: mask incomplete");
    this.emit();
    return this.out;
  }
}

/** 整段文字一次解析 */
export function parseSam(text: string): SamFrame[] {
  const s = new SamStream();
  return [...s.feed(text), ...s.close()];
}

/** Meta 的 SSE 原文 → 各個 response.output_text.delta 的文字（測試資料與診斷用） */
export function sseDeltas(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") continue;
    const ev = JSON.parse(payload) as { type?: string; delta?: unknown };
    if (ev.type === "response.output_text.delta" && typeof ev.delta === "string") out.push(ev.delta);
  }
  return out;
}
