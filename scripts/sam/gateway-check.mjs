// 本機閘道的 SAM 實測（docs/plan-10-28-sam.md S3／S6）：由 scripts/sam/live-local.ps1 起好閘道與權杖後執行。
// 1. 100 格的小檔走 POST /v1/sam → 輪詢到完成：逐格行數、計費格數（確認「送 40 格記 50」是倍數還是固定多 10）
// 2. 300 格的小檔開始後取消：從 DELETE 到狀態變 cancelled 要多久（應在幾秒內，不是 180 秒）
// 3. POST /v1/ai/mask-phrase：中文目標翻成英文名詞片語
// 環境變數：WORDBLADE_LIVE_GATEWAY、WORDBLADE_LIVE_TOKEN（只在行程裡，不印出）。結果：output/sam-gateway-check.json
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GATEWAY = process.env.WORDBLADE_LIVE_GATEWAY;
const TOKEN = process.env.WORDBLADE_LIVE_TOKEN;
const SAMPLE = join(ROOT, "samples", "fosdem-covid-3min.mp4");

/** 剪小檔：每 3 格取 1（30 fps → 10 fps）、640 寬、無聲（同 probe.mjs 的 cutClip） */
function clip(start, frames) {
  const out = join(ROOT, "output", `sam-check-${frames}.mp4`);
  execFileSync("ffmpeg", ["-v", "error", "-nostdin", "-y", "-ss", String(start), "-i", SAMPLE, "-map", "0:v:0", "-an",
    "-vf", "select='not(mod(n\\,3))',setpts=N*3/(30*TB),scale=640:-2:flags=area,format=yuv420p",
    "-frames:v", String(frames), "-r", "10", "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-movflags", "+faststart", out]);
  return readFileSync(out);
}

/** 呼叫閘道 */
async function call(path, init = {}) {
  const res = await fetch(`${GATEWAY}${path}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** 開始一個 SAM 工作 */
async function start(bytes, prompt) {
  const fd = new FormData();
  fd.append("prompt", prompt);
  fd.append("clip", new Blob([bytes], { type: "video/mp4" }), "clip.mp4");
  const r = await call("/v1/sam", { method: "POST", body: fd });
  if (r.status !== 202) throw new Error(`start ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.jobId;
}

/** 輪詢到結束（或 until 為真）；回傳最後狀態與全部行數 */
async function poll(id, until = () => false) {
  let after = 0;
  let lines = 0;
  for (;;) {
    const r = await call(`/v1/sam/${id}?after=${after}`);
    lines += r.body.lines.length;
    after = r.body.next;
    if (r.body.status !== "running" || until(lines)) return { ...r.body, lines };
    await new Promise((ok) => setTimeout(ok, 500));
  }
}

async function main() {
  if (!GATEWAY || !TOKEN) throw new Error("WORDBLADE_LIVE_GATEWAY / WORDBLADE_LIVE_TOKEN missing");
  const report = {};
  // 1. 100 格
  let t0 = performance.now();
  const done = await poll(await start(clip(30, 100), "person"));
  report.hundred = { status: done.status, error: done.error, lines: done.lines, framesProcessed: done.framesProcessed, seconds: +((performance.now() - t0) / 1000).toFixed(1) };
  // 2. 取消
  const id = await start(clip(60, 300), "person");
  const mid = await poll(id, (n) => n >= 5);
  t0 = performance.now();
  await call(`/v1/sam/${id}`, { method: "DELETE" });
  const after = await poll(id);
  report.cancel = { linesBeforeCancel: mid.lines, status: after.status, secondsToStop: +((performance.now() - t0) / 1000).toFixed(1) };
  // 3. 翻譯
  report.phrase = {};
  for (const text of ["車牌", "我的臉", "human face", "請幫我寫詩"]) report.phrase[text] = (await call("/v1/ai/mask-phrase", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) })).body;
  writeFileSync(join(ROOT, "output", "sam-gateway-check.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(String(e)); process.exit(1); });
