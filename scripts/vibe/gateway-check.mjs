// 閘道 /v1/ai/vibe 的實測（spec §5.7）：開始工作（描述＋截圖）→ 輪詢 → 用原專案的直譯器試跑新插件 → 不過就送回饋續跑（最多 3 輪）。
// 和 probe.mjs 的差別：走真正的閘道（權杖、背景工作、ChatMemory、用量紀錄），截圖走 Spring AI 的 Media。
// 用法：node scripts/vibe/gateway-check.mjs <閘道網址> （權杖放環境變數 WORDBLADE_TOKEN，不印出）
// 截圖：e2e/fixtures/talk.mp4 的一格（320×180 JPEG；小於 64 px 的圖 Muse 會默默丟掉）。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

const ROOT = join(import.meta.dirname, "..", "..");
const ANIM = join(ROOT, "src", "anim");
const base = process.argv[2] ?? "http://localhost:8080";
const token = process.env.WORDBLADE_TOKEN;
if (!token) throw new Error("set WORDBLADE_TOKEN");

/** 載入原專案的直譯器與執行環境 */
function loadRuntime() {
  const sandbox = { console, TextEncoder, performance };
  vm.createContext(sandbox);
  for (const f of ["vendor/acorn.js", "vendor/anim_vm.js", "vendor/anim_runtime.js"]) vm.runInContext(readFileSync(join(ANIM, f), "utf8"), sandbox, { filename: f });
  return vm.runInContext("AnimRuntime", sandbox);
}

/** 記錄指令的假畫布 */
function fakeCtx() {
  const noop = () => {};
  const gradient = () => ({ addColorStop() {} });
  return new Proxy({ canvas: { width: 1920, height: 1080 }, measureText: (s) => ({ width: [...s].length * 40 }), createLinearGradient: gradient, createRadialGradient: gradient, letterSpacing: "0px" },
    { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => ((t[k] = v), true) });
}

/** 呼叫閘道 */
async function api(path, init = {}) {
  const res = await fetch(base + path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

/** 等工作離開 running */
async function waitDone(jobId) {
  for (;;) {
    const { body } = await api(`/v1/ai/vibe/${jobId}`);
    if (body.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const RT = loadRuntime();
const jpeg = execFileSync("ffmpeg", ["-v", "error", "-ss", "1", "-i", join(ROOT, "e2e", "fixtures", "talk.mp4"), "-frames:v", "1", "-vf", "scale=320:180", "-f", "image2pipe", "-c:v", "mjpeg", "-"]);
const screenshot = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
const description = process.argv[3] ?? "A burst of colorful confetti shooting up from the bottom of the box";
const t0 = performance.now();
const start = await api("/v1/ai/vibe", { method: "POST", body: JSON.stringify({ description, screenshot, duration: 3, fps: 30, width: 1920, box: { x: 760, y: 420, w: 400, h: 240 } }) });
console.log(`POST /v1/ai/vibe → ${start.status}`);
if (start.status !== 202) process.exit(1);
const { jobId } = start.body;
for (;;) {
  const r0 = performance.now();
  const view = await waitDone(jobId);
  console.log(`round ${view.round}: ${view.status} ${view.result?.refusal ?? view.result?.mode ?? view.error ?? ""}（${((performance.now() - r0) / 1000).toFixed(1)} 秒）`);
  if (view.status !== "done" || view.result.refusal) break;
  const errors = [];
  view.result.components.forEach((c, i) => {
    try { RT.vetComponent(fakeCtx(), { ...c, id: "ai-draft", version: 1, schema: 2 }, { lintPaths: true }); }
    catch (e) { errors.push({ stage: e.stage ?? "schema", component: i, message: e.message, line: e.line ?? null, column: e.column ?? null }); }
  });
  console.log(`  components ${view.result.components.length}, layers ${view.result.anim.layers.length}, vet 錯誤 ${errors.length}`);
  if (!errors.length) break;
  const fb = await api(`/v1/ai/vibe/${jobId}/feedback`, { method: "POST", body: JSON.stringify({ errors }) });
  console.log(`  feedback → ${fb.status}`);
  if (fb.status !== 202) break;
}
console.log(`總計 ${((performance.now() - t0) / 1000).toFixed(1)} 秒`);
const other = await api(`/v1/ai/vibe/${jobId}`, { headers: { authorization: "Bearer wrong-token" } });
console.log(`錯誤權杖讀這個工作 → ${other.status}`);
