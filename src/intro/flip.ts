// 一鍵片頭「翻頁式」的計畫（spec §5.23、D34；參數取自調查 docs/research/intro-styles.md §1.4、§3.4 的 brand-v2 短版）。
// 純函式：輸入圖片、標題與時間 → cue 表（翻頁、上升音、閃光、標題進場、揭曉、結尾）＋每頁用哪張圖。
// 畫面（3D 插件）與聲音（A3 音效片段）都從同一份 cue 表衍生，所以一定同步。時間以秒存，換格交給合成器。

/** 一個時間點（相對片頭開頭） */
export interface IntroCue {
  t: number;
  kind: "page" | "riserStart" | "flash" | "titleIn" | "reveal" | "end";
  /** 第幾頁（page） */
  index?: number;
  /** 0～1：音效音量與畫面強度（翻頁越快越小） */
  strength?: number;
}

/** 翻頁式的參數（預設值是 brand-v2 短版） */
export interface FlipParams {
  /** 第一頁的停留秒數 */
  gap0: number;
  /** 每頁停留乘上的比例 */
  ratio: number;
  /** 最短停留幾格 */
  minFrames: number;
  /** 最多翻幾頁 */
  pages: number;
  /** 翻頁段長度（秒）：從 climax 往前推這麼久開始翻 */
  montage: number;
  /** 標題字裡輪流透出幾張封面 */
  titleFills: number;
}

export const FLIP_DEFAULTS: FlipParams = { gap0: 0.26, ratio: 0.86, minFrames: 2, pages: 16, montage: 1.8, titleFills: 7 };

/** 建議至少幾張圖（少於這個數會循環使用並提示） */
export const FLIP_MIN_IMAGES = 8;

/** 使用者的輸入 */
export interface FlipRequest {
  imageIds: string[];
  title: string;
  subtitle?: string;
  iconId?: string;
  fps: number;
  /** 圖片洗牌的固定種子（同一個種子結果相同，改參數重算不會換圖） */
  seed: number;
  /** 揭曉時間（秒）：沒有配樂 3.2；內建配樂 120 BPM 時是第 3 小節的 4.0 */
  reveal?: number;
  /** 片頭總長（秒）；預設揭曉後再 3 秒 */
  duration?: number;
  params?: Partial<FlipParams>;
}

/** 計畫 */
export interface FlipPlan {
  title: string;
  subtitle?: string;
  iconId?: string;
  duration: number;
  reveal: number;
  cues: IntroCue[];
  /** 每頁的圖片 id（和 page cue 一一對應） */
  pageImages: string[];
  /** 標題字裡輪流透出的圖片 id */
  titleFills: string[];
  params: FlipParams;
  warnings: string[];
}

/** 固定種子亂數（mulberry32） */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 洗牌（不改原陣列） */
function shuffle<T>(list: T[], rand: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** 從圖片裡挑 count 張：每輪重新洗牌、輪與輪交界不連續同一張 */
function pick(ids: string[], count: number, rand: () => number): string[] {
  const out: string[] = [];
  while (out.length < count) {
    const round = shuffle(ids, rand);
    if (ids.length > 1 && round[0] === out[out.length - 1]) round.push(round.shift()!);
    out.push(...round);
  }
  return out.slice(0, count);
}

/** 算翻頁式片頭的計畫；沒有圖片丟錯 */
export function flipIntro(req: FlipRequest): FlipPlan {
  if (!req.imageIds.length) throw new Error("The flip intro needs at least one image.");
  const params = { ...FLIP_DEFAULTS, ...req.params };
  const reveal = req.reveal ?? 3.2;
  const duration = req.duration ?? reveal + 3;
  /** 翻頁要在這之前翻完；標題從這裡進場，0.5 秒後揭曉 */
  const climax = reveal - 0.5;
  const minGap = params.minFrames / req.fps;
  const warnings: string[] = [];
  if (req.imageIds.length < FLIP_MIN_IMAGES) warnings.push(`Only ${req.imageIds.length} image(s); at least ${FLIP_MIN_IMAGES} look best — images are repeated.`);

  // 翻頁：每頁停留乘 ratio、最短 minGap；強度隨速度從 1 降到 0.55
  const cues: IntroCue[] = [];
  let t = Math.max(0, climax - params.montage);
  let gap = params.gap0;
  for (let i = 0; i < params.pages && t < climax; i++) {
    const speed = params.gap0 > minGap ? (params.gap0 - gap) / (params.gap0 - minGap) : 1;
    cues.push({ t, kind: "page", index: i, strength: 1 - 0.45 * speed });
    t += gap;
    gap = Math.max(minGap, gap * params.ratio);
  }
  cues.push(
    { t: Math.max(0, climax - 2), kind: "riserStart" },
    { t: climax - 0.04, kind: "flash" },
    { t: climax, kind: "titleIn" },
    { t: reveal, kind: "reveal" },
    { t: duration, kind: "end" },
  );
  cues.sort((a, b) => a.t - b.t);

  const rand = random(req.seed);
  const pages = cues.filter((c) => c.kind === "page").length;
  return {
    title: req.title, subtitle: req.subtitle, iconId: req.iconId,
    duration, reveal, cues, params, warnings,
    pageImages: pick(req.imageIds, pages, rand),
    titleFills: pick(req.imageIds, params.titleFills, rand),
  };
}
