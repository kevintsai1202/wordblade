// 材質後處理實機比對（spec §5.12）：把 output/texture-probe/ 的原圖跑 downscale → 去暗角 → 無縫化 → 法線，
// 輸出「原圖 2×2 拼貼」與「處理後 2×2 拼貼」、法線圖到 output/texture-probe/processed/，並印處理前後的接縫差。
// 用法：node --experimental-strip-types scripts/texture/process-probe.mjs（要 PATH 上有 ffmpeg，用來解碼 webp、編碼 png）
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { downscale, edgeSeam, flattenVignette, makeSeamless, normalMap } from "../../src/texture/process.ts";

const DIR = join(import.meta.dirname, "..", "..", "output", "texture-probe");
const OUT = join(DIR, "processed");
mkdirSync(OUT, { recursive: true });
const SIZE = 512;

/** 用 ffmpeg 解成 SIZE×SIZE 的 RGBA（先讓 ffmpeg 縮到 1024，再用我們的 downscale 縮到 SIZE） */
function decode(file) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vf", "scale=1024:1024", "-f", "rawvideo", "-pix_fmt", "rgba", "-"], { maxBuffer: 1 << 26 });
  return downscale({ data: new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length), width: 1024, height: 1024 }, SIZE);
}

/** RGBA → 2×2 拼貼 PNG */
function tile(p, file) {
  const { width: w, height: h } = p;
  const big = Buffer.alloc(w * 2 * h * 2 * 4);
  for (let ty = 0; ty < 2; ty++) for (let y = 0; y < h; y++) for (let tx = 0; tx < 2; tx++) Buffer.from(p.data.buffer, p.data.byteOffset + y * w * 4, w * 4).copy(big, ((ty * h + y) * w * 2 + tx * w) * 4);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${w * 2}x${h * 2}`, "-i", "-", file], { input: big });
}

for (const f of readdirSync(DIR).filter((n) => /\.(webp|png)$/.test(n))) {
  const name = f.replace(/\.[^.]+$/, "");
  const src = decode(join(DIR, f));
  const done = makeSeamless(flattenVignette(src));
  tile(src, join(OUT, `${name}-raw-2x2.png`));
  tile(done, join(OUT, `${name}-seamless-2x2.png`));
  tile(normalMap(done, 2), join(OUT, `${name}-normal-2x2.png`));
  console.log(`${name}: seam ${edgeSeam(src).toFixed(1)} → ${edgeSeam(done).toFixed(1)}`);
}
