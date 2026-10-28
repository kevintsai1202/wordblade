// AI 導演的本機閘道實測（docs/plan-10-28-director.md R2）：由 scripts/sam/live-local.ps1 -Check scripts/director/gateway-check.mjs 起好閘道與權杖後執行。
// 模擬短片 samples/demo-2min.mp4（108 秒，一段）：ffmpeg 轉 480p、每秒 2 格、250 kbps → 建工作 → 上傳一段（詞由 truth.json 的句子平均攤開，
// id 像 demo:w12）→ 輪詢到完成 → 檢查有沒有找到正確答案：假金鑰（31.4～43.0 秒）要有 mask、重講（49.3～54.6 秒）要有 cut。
// 環境變數：WORDBLADE_LIVE_GATEWAY、WORDBLADE_LIVE_TOKEN。結果：output/director-gateway-check.json
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATEWAY = process.env.WORDBLADE_LIVE_GATEWAY;
const TOKEN = process.env.WORDBLADE_LIVE_TOKEN;
const SAMPLE = join(ROOT, "samples", "demo-2min.mp4");
const truth = JSON.parse(readFileSync(join(ROOT, "samples", "demo-2min.truth.json"), "utf8"));

/** 3D 場景（和 src/three/builtins.ts 的 TEMPLATES_3D 一致的幾個） */
const SCENES = [
  { id: "board-swing-in", name: "Floating board — swings in from the side" },
  { id: "board-float", name: "Floating board — gentle sway" },
  { id: "desk-reveal", name: "Screen on a desk — pull back and return" },
  { id: "mascot-point", name: "Mascot walks in and points at the box" },
];

/** 句子 → 詞（句子時間內平均攤開） */
function wordsFromTruth() {
  const out = [];
  for (const s of truth.sentences) {
    const tokens = s.text.split(/\s+/).filter(Boolean);
    tokens.forEach((text, i) => out.push({ id: `demo:w${out.length}`, t: +(s.start + ((s.end - s.start) * i) / tokens.length).toFixed(2), text }));
  }
  return out;
}

/** 呼叫閘道 */
async function call(path, init = {}) {
  const res = await fetch(`${GATEWAY}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** 兩段時間有沒有重疊 */
const overlaps = (s, a, b) => s.start < b && s.end > a;

async function main() {
  if (!GATEWAY || !TOKEN) throw new Error("WORDBLADE_LIVE_GATEWAY / WORDBLADE_LIVE_TOKEN missing");
  const clip = join(ROOT, "output", "director-check.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-y", "-i", SAMPLE, "-an", "-vf", "fps=2,scale=-2:480", "-c:v", "libx264", "-b:v", "250k", "-maxrate", "250k", "-bufsize", "500k", "-movflags", "+faststart", clip]);
  const t0 = performance.now();
  const { jobId } = await call("/v1/ai/director", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mediaName: "demo-2min.mp4", duration: truth.duration, segments: 1, scenes: SCENES }) });
  const fd = new FormData();
  fd.append("video", new Blob([readFileSync(clip)], { type: "video/mp4" }), "segment.mp4");
  fd.append("meta", JSON.stringify({ start: 0, end: truth.duration, words: wordsFromTruth() }));
  await call(`/v1/ai/director/${jobId}/segments/0`, { method: "POST", body: fd });
  let view;
  for (;;) {
    view = await call(`/v1/ai/director/${jobId}`);
    if (!["collecting", "planning"].includes(view.status)) break;
    await new Promise((r) => setTimeout(r, 2000));
  }
  const seconds = +((performance.now() - t0) / 1000).toFixed(1);
  const foundKey = view.suggestions.some((s) => s.kind === "mask" && overlaps(s, truth.apiKey.start, truth.apiKey.end));
  const foundRetake = view.suggestions.some((s) => s.kind === "cut" && overlaps(s, truth.retake.start, truth.retake.end));
  const report = { seconds, status: view.status, error: view.error, segmentsFailed: view.segmentsFailed, foundKey, foundRetake, suggestions: view.suggestions };
  writeFileSync(join(ROOT, "output", "director-gateway-check.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (view.status !== "done" || !foundKey || !foundRetake) process.exit(1);
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
