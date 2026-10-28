// SAM 3.1 實測（spec §5.3，docs/plan-10-28-sam.md S1）：剪一小段無聲、縮小的影片 → Meta Files API（一小時到期）→
// /v1/responses（sam-3.1、串流、one_bit 遮罩）→ 把原始串流存起來當解析與 e2e 的測試資料 → 刪檔。
// 記錄：事件種類、有沒有 [DONE]、completed 之後連線會不會關、usage、各步驟耗時、格數與估價（US$0.20／千格）。
//
// 執行（PowerShell，repo 根目錄）：
//   node scripts/sam/probe.mjs samples/fosdem-covid-3min.mp4 --start 30 --seconds 4 --fps 10 --width 640 --prompt "human face" --name fosdem-face
// 需要：.env 的 META_API_KEY（只讀進行程，不印出）、WORDBLADE_MODEL_SAM（沒有就用 sam-3.1）；PATH 上有 ffmpeg、ffprobe。
// 結果：src/sam/fixtures/<name>.sse（原始串流位元組）、output/sam-probe-<name>.json（統計；終端也印）
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

/** repo 根目錄 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = "https://api.meta.ai/v1";

/** 讀 .env */
function loadEnv() {
  const text = readFileSync(join(ROOT, ".env"), "utf-8");
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes("=") && !l.trimStart().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
}

/** 命令列參數 */
function parseArgs(argv) {
  const out = { file: argv[0], start: 30, seconds: 4, fps: 10, width: 640, prompt: "human face", name: "probe" };
  for (let i = 1; i < argv.length; i += 2) out[argv[i].replace(/^--/, "")] = argv[i + 1];
  for (const k of ["start", "seconds", "fps", "width"]) out[k] = Number(out[k]);
  return out;
}

/** 原片格率（分數） */
function sourceFps(file) {
  const [n, d] = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=r_frame_rate", "-of", "csv=p=0", file], { encoding: "utf8" }).trim().split("/").map(Number);
  return { n, d: d || 1 };
}

/**
 * 剪小檔（照搬原專案 cut_clip）：每 step 格取一格、時間戳改成連續、縮到 width（偶數）、H.264、無聲
 * 回傳 { bytes, frames }
 */
function cutClip(file, start, seconds, fps, width) {
  const src = sourceFps(file);
  const rate = src.n / src.d;
  const step = Math.max(1, Math.floor(rate / fps + 0.5));
  const frames = Math.ceil((seconds * rate) / step);
  const out = join(ROOT, "output", "sam-probe-clip.mp4");
  const ss = start > 0 ? ["-ss", ((start * rate - 0.25) / rate).toFixed(6)] : [];
  execFileSync("ffmpeg", [
    "-v", "error", "-nostdin", "-y", ...ss, "-i", file, "-map", "0:v:0", "-an", "-sn", "-dn",
    "-vf", `select='not(mod(n\\,${step}))',setpts=N*${src.d * step}/(${src.n}*TB),scale=${width}:-2:flags=area,format=yuv420p`,
    "-frames:v", String(frames), "-r", `${src.n}/${src.d * step}`,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", out,
  ]);
  return { bytes: readFileSync(out), frames, step };
}

/** Files API 上傳（multipart 自己組：Content-Length 等由 fetch 算） */
async function upload(env, bytes) {
  const b = randomUUID().replaceAll("-", "");
  const field = (k, v) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`;
  const head = field("purpose", "user_data") + field("expires_after[anchor]", "created_at") + field("expires_after[seconds]", "3600")
    + `--${b}\r\nContent-Disposition: form-data; name="file"; filename="clip.mp4"\r\nContent-Type: video/mp4\r\n\r\n`;
  const body = Buffer.concat([Buffer.from(head), bytes, Buffer.from(`\r\n--${b}--\r\n`)]);
  const res = await fetch(`${BASE}/files`, { method: "POST", headers: { authorization: `Bearer ${env.META_API_KEY}`, "content-type": `multipart/form-data; boundary=${b}` }, body });
  const text = await res.text();
  if (!res.ok) throw new Error(`upload ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

/** 呼叫 SAM（串流），回傳原始位元組與時間軸 */
async function track(env, fileId, prompt) {
  const body = { model: env.WORDBLADE_MODEL_SAM || "sam-3.1", stream: true, metadata: { mask_encoding: "one_bit" }, input: [{ type: "message", role: "user", content: [{ type: "input_text", text: prompt }, { type: "input_video", file_id: fileId }] }] };
  const t0 = performance.now();
  const res = await fetch(`${BASE}/responses`, { method: "POST", headers: { authorization: `Bearer ${env.META_API_KEY}`, "content-type": "application/json", accept: "text/event-stream" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`responses ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const chunks = [];
  let firstByte = null;
  let completedAt = null;
  const reader = res.body.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    firstByte ??= performance.now() - t0;
    chunks.push(Buffer.from(value));
    if (completedAt === null && Buffer.concat(chunks).includes("response.completed")) completedAt = performance.now() - t0;
  }
  return { raw: Buffer.concat(chunks), firstByteMs: Math.round(firstByte), completedMs: completedAt && Math.round(completedAt), closedMs: Math.round(performance.now() - t0) };
}

/** 刪檔（不查詢確認：刪除後 GET 會在 404／200 之間跳） */
async function remove(env, fileId) {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/files/${fileId}`, { method: "DELETE", headers: { authorization: `Bearer ${env.META_API_KEY}` } });
  return { status: res.status, ms: Math.round(performance.now() - t0) };
}

/** 主流程 */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  if (!env.META_API_KEY) throw new Error("META_API_KEY missing in .env");
  mkdirSync(join(ROOT, "output"), { recursive: true });
  mkdirSync(join(ROOT, "src", "sam", "fixtures"), { recursive: true });
  const clip = cutClip(resolve(args.file), args.start, args.seconds, args.fps, args.width);
  let t0 = performance.now();
  const file = await upload(env, clip.bytes);
  const uploadMs = Math.round(performance.now() - t0);
  let result;
  try {
    result = await track(env, file.id, args.prompt);
  } finally {
    var deleted = await remove(env, file.id);
  }
  writeFileSync(join(ROOT, "src", "sam", "fixtures", `${args.name}.sse`), result.raw);
  // 統計事件
  const lines = result.raw.toString("utf8").split(/\r?\n/);
  const types = {};
  let text = "";
  let usage = null;
  let doneMarker = false;
  for (const l of lines) {
    if (!l.startsWith("data:")) continue;
    const payload = l.slice(5).trim();
    if (payload === "[DONE]") { doneMarker = true; continue; }
    const ev = JSON.parse(payload);
    types[ev.type] = (types[ev.type] ?? 0) + 1;
    if (ev.type === "response.output_text.delta") text += ev.delta;
    if (ev.response?.usage) usage = ev.response.usage;
  }
  const frameLines = text.split("\n").filter((l) => l.startsWith("<"));
  const objects = frameLines.reduce((n, l) => n + l.split(">,").length, 0);
  const report = {
    args: { ...args, file: undefined }, clipBytes: clip.bytes.length, clipFrames: clip.frames, step: clip.step,
    upload: { ms: uploadMs, keys: Object.keys(file) }, ...result, raw: undefined,
    rawBytes: result.raw.length, eventTypes: types, doneMarker, usage, framesWithObjects: frameLines.length, objects,
    sample: frameLines[0]?.slice(0, 160), estimatedUsd: +(clip.frames * 0.2 / 1000).toFixed(4), deleted,
  };
  writeFileSync(join(ROOT, "output", `sam-probe-${args.name}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
