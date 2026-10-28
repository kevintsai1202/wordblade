// 發佈包的本機閘道實測（docs/plan-10-29-publish.md K2）：由 scripts/sam/live-local.ps1 -Check scripts/publish/gateway-check.mjs 起好閘道與權杖後執行。
// ① /v1/ai/publish：samples/demo-2min 的句子（truth.json，每句一行、成片時間＝句子開始）→ 輪詢到完成 → 檢查 3 個標題、章節時間落在句首附近、語言是英文。
// ② /v1/ai/image：demo 第 20 秒那一格（PNG）＋風格描述 → 輪詢到完成 → 存成 output/publish-check-thumb.webp。
// 環境變數：WORDBLADE_LIVE_GATEWAY、WORDBLADE_LIVE_TOKEN。結果：output/publish-gateway-check.json。會實際呼叫 Spark 與 Muse Image（約 US$0.02）。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATEWAY = process.env.WORDBLADE_LIVE_GATEWAY;
const TOKEN = process.env.WORDBLADE_LIVE_TOKEN;
const SAMPLE = join(ROOT, "samples", "demo-2min.mp4");
const truth = JSON.parse(readFileSync(join(ROOT, "samples", "demo-2min.truth.json"), "utf8"));

/** 呼叫閘道 */
async function call(path, init = {}) {
  const res = await fetch(`${GATEWAY}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : null;
}

/** 輪詢到不是 running */
async function poll(path, maxSeconds) {
  for (let i = 0; i < maxSeconds; i++) {
    const v = await call(path);
    if (v.status !== "running") return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${path} timed out`);
}

const result = {};

// ① 發佈包文字
{
  const lines = truth.sentences.map((s) => ({ t: s.start, text: s.text }));
  const t0 = Date.now();
  const { jobId } = await call("/v1/ai/publish", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ language: "en", duration: 108, lines }) });
  const v = await poll(`/v1/ai/publish/${jobId}`, 120);
  const starts = lines.map((l) => l.t);
  const nearStart = (v.kit?.chapters ?? []).map((c) => Math.min(...starts.map((s) => Math.abs(s - c.t))));
  result.publish = { ms: Date.now() - t0, status: v.status, error: v.error, kit: v.kit, chapterOffsets: nearStart };
  console.log("publish", v.status, `${Date.now() - t0} ms`, "titles", v.kit?.titles?.length, "chapters", v.kit?.chapters?.length, "max offset", Math.max(0, ...nearStart).toFixed(2));
}

// ② 縮圖底圖
{
  const frame = execFileSync("ffmpeg", ["-v", "error", "-ss", "20", "-i", SAMPLE, "-frames:v", "1", "-vf", "scale=1280:-2", "-f", "image2pipe", "-c:v", "png", "-"]);
  const form = new FormData();
  form.append("purpose", "thumbnail");
  form.append("prompt", "bold tech tutorial look, blue and orange");
  form.append("image", new Blob([frame], { type: "image/png" }), "frame.png");
  const t0 = Date.now();
  const { jobId } = await call("/v1/ai/image", { method: "POST", body: form });
  const v = await poll(`/v1/ai/image/${jobId}`, 180);
  if (v.image) writeFileSync(join(ROOT, "output", "publish-check-thumb.webp"), Buffer.from(v.image, "base64"));
  result.image = { ms: Date.now() - t0, status: v.status, error: v.error, mime: v.mime, bytes: v.image ? Buffer.from(v.image, "base64").length : 0 };
  console.log("image", v.status, `${Date.now() - t0} ms`, v.mime, result.image.bytes, "bytes");
}

writeFileSync(join(ROOT, "output", "publish-gateway-check.json"), JSON.stringify(result, null, 2));
const ok = result.publish.status === "done" && result.publish.kit.titles.length === 3 && result.image.status === "done";
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
