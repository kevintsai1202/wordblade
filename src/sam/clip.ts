// SAM 用的小檔（spec §5.3）：素材 [start, end) 轉成寬 ≤ 1280、每秒 fps 格、無聲的 H.264 MP4（mediabunny＋WebCodecs，桌面與網頁共用，
// 和匯出讀素材同一條路：Engine.exportSource）。轉好後再把小檔解成 64 寬的小畫面算逐格差異（換鏡頭判斷），並記下每格的素材時間。
import { CLIP_BITRATE, clipSize } from "./plan";

/** 換鏡頭掃描用的小畫面寬度（原專案 CUT_WIDTH） */
const CUT_WIDTH = 64;

/** 轉好的小檔 */
export interface SamClip {
  bytes: Uint8Array;
  width: number;
  height: number;
  /** 各格的素材時間 */
  times: number[];
  /** 相鄰兩格的平均像素差（0～255，第 0 格是 0） */
  diffs: number[];
}

/**
 * 素材的一段 → SAM 小檔。source：Engine.exportSource 的結果（網頁版 File、桌面版 asset 網址）；videoW／videoH：素材原尺寸。
 * signal 取消時丟 AbortError。
 */
export async function makeSamClip(source: Blob | string, start: number, end: number, opts: { fps: number; maxWidth: number; videoW: number; videoH: number; signal?: AbortSignal }): Promise<SamClip> {
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: typeof source === "string" ? new mb.UrlSource(source) : new mb.BlobSource(source), formats: mb.ALL_FORMATS });
  const target = new mb.BufferTarget();
  const output = new mb.Output({ format: new mb.Mp4OutputFormat({ fastStart: "in-memory" }), target });
  const size = clipSize(opts.videoW, opts.videoH, opts.maxWidth);
  try {
    const conversion = await mb.Conversion.init({
      input, output, tracks: "primary", trim: { start, end },
      video: { width: size.width, height: size.height, fit: "fill", frameRate: opts.fps, codec: "avc", bitrate: CLIP_BITRATE, forceTranscode: true, hardwareAcceleration: "no-preference" },
      audio: { discard: true },
      showWarnings: false,
    });
    if (!conversion.isValid) throw new Error("This video can't be converted for masking.");
    const abort = () => void conversion.cancel();
    opts.signal?.addEventListener("abort", abort);
    try {
      await conversion.execute();
    } finally {
      opts.signal?.removeEventListener("abort", abort);
    }
    if (opts.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  } finally {
    input.dispose();
  }
  const bytes = new Uint8Array(target.buffer!);
  const { times, diffs } = await scanClip(mb, bytes, start);
  return { bytes, width: size.width, height: size.height, times, diffs };
}

/** 把小檔解成 64 寬的小畫面：每格的時間（換回素材時間）與相鄰兩格的平均像素差 */
async function scanClip(mb: typeof import("mediabunny"), bytes: Uint8Array, start: number): Promise<{ times: number[]; diffs: number[] }> {
  const input = new mb.Input({ source: new mb.BufferSource(bytes), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("No video in the converted clip");
    const first = await track.getFirstTimestamp();
    const times: number[] = [];
    const diffs: number[] = [];
    let prev: Uint8ClampedArray | null = null;
    for await (const { canvas, timestamp } of new mb.CanvasSink(track, { width: CUT_WIDTH, poolSize: 2 }).canvases()) {
      const ctx = (canvas as HTMLCanvasElement | OffscreenCanvas).getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let d = 0;
      if (prev) {
        let sum = 0;
        let n = 0;
        // RGBA：只算 RGB
        for (let i = 0; i < px.length; i += 4, n += 3) sum += Math.abs(px[i] - prev[i]) + Math.abs(px[i + 1] - prev[i + 1]) + Math.abs(px[i + 2] - prev[i + 2]);
        d = sum / n;
      }
      prev = new Uint8ClampedArray(px);
      times.push(Math.round((start + timestamp - first) * 1e6) / 1e6);
      diffs.push(d);
    }
    return { times, diffs };
  } finally {
    input.dispose();
  }
}
