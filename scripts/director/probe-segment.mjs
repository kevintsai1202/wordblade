// AI 導演的逐段呼叫實測（docs/plan-10-28-director.md R0）：Muse Spark 能不能一次看完一段 480p、每秒 2 格、無聲的影片
// （video_url 的 base64），耗時與 token 多少。同一支素材剪三種：120 秒 250 kbps、120 秒 150 kbps、60 秒 250 kbps。
//
// 執行（PowerShell，repo 根目錄）：node scripts/director/probe-segment.mjs samples/demo-2min.mp4
// 需要：.env 的 META_API_KEY（只讀進行程，不印出）、WORDBLADE_MODEL_SPARK；PATH 上有 ffmpeg。
// 結果：output/director-probe.json（終端也印）
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 讀 .env */
function loadEnv() {
  const text = readFileSync(join(ROOT, ".env"), "utf-8");
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes("=") && !l.trimStart().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
}

/** 剪一段：高 480、每秒 2 格、無聲、指定位元率 */
function cut(file, seconds, kbps) {
  const out = join(ROOT, "output", `director-probe-${seconds}s-${kbps}k.mp4`);
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", file, "-t", String(seconds), "-an", "-vf", "fps=2,scale=-2:480", "-c:v", "libx264", "-b:v", `${kbps}k`, "-maxrate", `${kbps}k`, "-bufsize", `${kbps * 2}k`, "-movflags", "+faststart", out]);
  return readFileSync(out);
}

/** 結構化報告的 schema（實際用的會更完整，這裡只量能不能看、看得到什麼） */
const SCHEMA = {
  type: "object", additionalProperties: false, required: ["summary", "screenText", "privacy"],
  properties: {
    summary: { type: "string" },
    screenText: { type: "array", items: { type: "string" } },
    privacy: { type: "array", items: { type: "object", additionalProperties: false, required: ["seconds", "what"], properties: { seconds: { type: "number" }, what: { type: "string" } } } },
  },
};

/** 送一段 */
async function ask(env, bytes) {
  const body = {
    model: env.WORDBLADE_MODEL_SPARK || "muse-spark-1.3-contributor",
    reasoning_effort: "low",
    response_format: { type: "json_schema", json_schema: { name: "segment", strict: true, schema: SCHEMA } },
    messages: [{ role: "user", content: [
      { type: "text", text: "This is a silent screen recording sampled at 2 frames per second. Summarize it, list readable on-screen text, and list privacy-sensitive items (API keys, emails, faces, name badges) with the second they first appear." },
      { type: "video_url", video_url: { url: `data:video/mp4;base64,${bytes.toString("base64")}` } },
    ] }],
  };
  const t0 = performance.now();
  const res = await fetch("https://api.meta.ai/v1/chat/completions", { method: "POST", headers: { authorization: `Bearer ${env.META_API_KEY}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  const seconds = +((performance.now() - t0) / 1000).toFixed(1);
  if (!res.ok) return { status: res.status, seconds, error: text.slice(0, 300) };
  const json = JSON.parse(text);
  return { status: res.status, seconds, usage: json.usage, answer: JSON.parse(json.choices[0].message.content) };
}

async function main() {
  const file = resolve(process.argv[2] ?? join(ROOT, "samples", "demo-2min.mp4"));
  const env = loadEnv();
  if (!env.META_API_KEY) throw new Error("META_API_KEY missing in .env");
  const report = [];
  for (const [seconds, kbps] of [[120, 250], [120, 150], [60, 250]]) {
    const bytes = cut(file, seconds, kbps);
    report.push({ seconds, kbps, bytes: bytes.length, ...(await ask(env, bytes)) });
  }
  writeFileSync(join(ROOT, "output", "director-probe.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
