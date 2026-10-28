// Muse Image 實測（發佈包縮圖，spec §5.12、§5.17）：
//   ① /v1/images/generations：一句描述 → 16:9 圖（看 size 參數格式、回傳是 b64_json 還是 url、實際尺寸、耗時）
//   ② /v1/images/edits：demo-2min 的一格當底圖 → 改成 YouTube 縮圖風格（不畫字）（multipart，看欄位名與回傳）
// 執行（PowerShell，repo 根目錄）：node scripts/publish/probe-image.mjs [秒數]
// 需要：.env 的 META_API_KEY（只讀進行程，不印出）、WORDBLADE_MODEL_IMAGE；PATH 上有 ffmpeg。
// 結果：output/image-probe/（圖檔）與 output/image-probe/result.json（回應結構、尺寸、耗時；不含金鑰）
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "output", "image-probe");
const SAMPLE = join(ROOT, "samples", "demo-2min.mp4");
const BASE = "https://api.meta.ai/v1";

/** 讀 .env */
function loadEnv() {
  const text = readFileSync(join(ROOT, ".env"), "utf-8");
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes("=") && !l.trimStart().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
}

/** 圖片尺寸（ffprobe） */
function size(file) {
  return execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", file], { encoding: "utf8" }).trim();
}

/** 回應結構：只留鍵名與型別，長字串截斷 */
function shape(v, depth = 0) {
  if (Array.isArray(v)) return v.length ? [shape(v[0], depth + 1)] : [];
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, depth > 3 ? typeof x : shape(x, depth + 1)]));
  if (typeof v === "string") return v.length > 80 ? `string(${v.length})` : v;
  return v;
}

/** 把回應裡的第一張圖存檔（b64_json 或 url） */
async function saveImage(json, name) {
  const item = json?.data?.[0];
  if (!item) return null;
  const bytes = item.b64_json ? Buffer.from(item.b64_json, "base64") : item.url ? Buffer.from(await (await fetch(item.url)).arrayBuffer()) : null;
  if (!bytes) return null;
  const file = join(OUT, name);
  writeFileSync(file, bytes);
  return { file, bytes: bytes.length, size: size(file) };
}

const env = loadEnv();
const model = env.WORDBLADE_MODEL_IMAGE;
const auth = { authorization: `Bearer ${env.META_API_KEY}` };
mkdirSync(OUT, { recursive: true });
const result = { model };

// ① 產生
{
  const body = { model, prompt: "A bold YouTube thumbnail background: a glowing laptop on a dark desk, dramatic blue and purple lighting, no text", size: "1792x1024", n: 1 };
  const t0 = Date.now();
  const res = await fetch(`${BASE}/images/generations`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
  result.generate = { status: res.status, ms: Date.now() - t0, shape: json ? shape(json) : text.slice(0, 500), saved: res.ok ? await saveImage(json, "generate.png") : null };
  console.log("generate", res.status, result.generate.ms, "ms");
}

// ② 改圖：底圖用 demo 的一格
{
  const t = process.argv[2] ?? "20";
  const frame = execFileSync("ffmpeg", ["-v", "error", "-ss", t, "-i", SAMPLE, "-frames:v", "1", "-vf", "scale=1280:-2", "-f", "image2pipe", "-c:v", "png", "-"]);
  writeFileSync(join(OUT, "edit-source.png"), frame);
  const form = new FormData();
  form.append("model", model);
  form.append("prompt", "Turn this video frame into an eye-catching YouTube thumbnail: punchy contrast, vivid colors, cinematic lighting, keep the main subject recognizable. Do not add any text, letters or logos.");
  form.append("size", "1792x1024");
  form.append("image", new Blob([frame], { type: "image/png" }), "frame.png");
  const t0 = Date.now();
  const res = await fetch(`${BASE}/images/edits`, { method: "POST", headers: auth, body: form });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 不是 JSON */ }
  result.edit = { status: res.status, ms: Date.now() - t0, shape: json ? shape(json) : text.slice(0, 500), saved: res.ok ? await saveImage(json, "edit.png") : null };
  console.log("edit", res.status, result.edit.ms, "ms");
}

writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
