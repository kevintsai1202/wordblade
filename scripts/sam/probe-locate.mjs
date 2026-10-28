// Spark 定位螢幕文字的實測（遮罩：SAM 抓不到的帳號、密碼、金鑰等文字類個資）：demo-2min 的幾格（寬 1280 JPEG）一次送 Spark，
// 請它回每格裡要遮的項目的框，和正確答案（truth.json 的 apiKey.box）比 IoU；同時量 tokens 與耗時。
//
// 執行（PowerShell，repo 根目錄）：node scripts/sam/probe-locate.mjs [秒數,秒數,…]
// 需要：.env 的 META_API_KEY（只讀進行程，不印出）、WORDBLADE_MODEL_SPARK；PATH 上有 ffmpeg。結果：output/locate-probe.json
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SAMPLE = join(ROOT, "samples", "demo-2min.mp4");
const truth = JSON.parse(readFileSync(join(ROOT, "samples", "demo-2min.truth.json"), "utf8"));

/** 讀 .env */
function loadEnv() {
  const text = readFileSync(join(ROOT, ".env"), "utf-8");
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes("=") && !l.trimStart().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
}

/** 某一秒的畫面 → 寬 1280 JPEG（base64） */
function frame(t) {
  return execFileSync("ffmpeg", ["-v", "error", "-ss", String(t), "-i", SAMPLE, "-frames:v", "1", "-vf", "scale=1280:-2", "-q:v", "3", "-f", "image2pipe", "-c:v", "mjpeg", "-"]).toString("base64");
}

const SCHEMA = {
  type: "object", additionalProperties: false, required: ["frames"],
  properties: { frames: { type: "array", items: { type: "object", additionalProperties: false, required: ["index", "items"], properties: {
    index: { type: "integer" },
    items: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "x", "y", "w", "h"], properties: {
      text: { type: "string" }, x: { type: "number" }, y: { type: "number" }, w: { type: "number" }, h: { type: "number" } } } },
  } } } },
};

/** IoU */
function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  const inter = ix * iy;
  return inter / (a.w * a.h + b.w * b.h - inter);
}

async function main() {
  const env = loadEnv();
  const times = (process.argv[2] ?? "32,36,40").split(",").map(Number);
  const content = [{ type: "text", text: `Find every "API key or secret token" visible in each of these ${times.length} screenshots of a screen recording (image i is frame index i, starting at 0). For each frame list each occurrence with the exact text you read and its tight bounding box as fractions of the image (x, y = top-left corner, w, h; 0 to 1). Only the secret value itself, not labels. Empty list if none.` }];
  for (const t of times) content.push({ type: "image_url", image_url: { url: `data:image/jpeg;base64,${frame(t)}` } });
  const body = { model: env.WORDBLADE_MODEL_SPARK || "muse-spark-1.3-contributor", reasoning_effort: "low", response_format: { type: "json_schema", json_schema: { name: "locate", strict: true, schema: SCHEMA } }, messages: [{ role: "user", content }] };
  const t0 = performance.now();
  const res = await fetch("https://api.meta.ai/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${env.META_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const json = await res.json();
  const seconds = +((performance.now() - t0) / 1000).toFixed(1);
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json).slice(0, 300)}`);
  const answer = JSON.parse(json.choices[0].message.content);
  const box = truth.apiKey.box;
  const scored = answer.frames.map((f) => ({ t: times[f.index], items: f.items.map((i) => ({ ...i, iou: +iou(i, box).toFixed(2) })) }));
  const report = { seconds, usage: json.usage, truthBox: box, frames: scored };
  writeFileSync(join(ROOT, "output", "locate-probe.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
