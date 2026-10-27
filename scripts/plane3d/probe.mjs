// 「用說的」實測（spec §5.8）：用閘道同一份系統提示詞直接呼叫 Muse Spark（推理 low），量每句的耗時與 token，
// 並用原專案的姿勢數學檢查：關鍵幀換算後遞增、姿勢路徑可用（PLANE3D.pathValid）、方向符合描述。
// 用法（repo 根目錄）：node scripts/plane3d/probe.mjs [--model spark|wonder]
// 金鑰與模型 ID 從 .env 讀（不印出）；結果寫 logs/plane3d-probe-<model>.json。
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlane3d, systemPrompt, userText } from "./prompt.mjs";

const ROOT = join(import.meta.dirname, "..", "..");

/** .env 讀成物件（不印出） */
function loadEnv() {
  const env = {};
  for (const line of readFileSync(join(ROOT, ".env"), "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

/** 測試描述與方向檢查（check 收到合併後的設定，回傳 true／false） */
const CASES = [
  { id: 1, text: "Swing in from the right side", check: (p) => p.keys[0].ry > 20 },
  { id: 2, text: "Tilt up from below, then push in close", check: (p) => p.keys.some((k) => k.rx > 15) },
  { id: 3, text: "Just float gently in the middle", check: (p) => !!p.float },
  { id: 4, text: "At the end, swing out to the left", check: (p) => p.keys.some((k) => k.anchor === "end" && k.ry < -20) },
  { id: 5, text: "Make the board small and move it to the upper left", check: (p) => p.keys.some((k) => k.size < 0.8 && k.px < 0 && k.py < 0) },
  { id: 6, text: "Put it on the dark tech grid background", check: (p) => p.background === "grid" },
  { id: 7, text: "Spin around once clockwise while zooming out", check: (p) => p.keys.some((k) => Math.abs(k.rz) > 90) },
  { id: 8, text: "Write me a poem about the ocean", refuse: true },
];

const args = process.argv.slice(2);
const which = args.includes("--model") ? args[args.indexOf("--model") + 1] : "spark";
const env = loadEnv();
const model = which === "wonder"
  ? { name: "wonder", id: env.WORDBLADE_MODEL_WONDER || "muse-wonder-1.0", reasoning: "medium" }
  : { name: "spark", id: env.WORDBLADE_MODEL_SPARK || "muse-spark-1.3-contributor", reasoning: "low" };
const P = loadPlane3d();
const system = systemPrompt();
const current = { keys: [{ anchor: "start", t: 0, rx: 0, ry: 0, rz: 0, size: 0.8, px: 0, py: 0, ease: "inOut" }], float: null, edges: true, background: "studio" };
const L = 6;
const results = [];
for (const c of CASES) {
  const t0 = performance.now();
  let res;
  try {
    res = await fetch("https://api.meta.ai/v1/chat/completions", {
    signal: AbortSignal.timeout(90_000),
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.META_API_KEY}` },
    body: JSON.stringify({
      model: model.id, reasoning_effort: model.reasoning, response_format: { type: "json_object" },
      messages: [{ role: "system", content: system }, { role: "user", content: userText({ length: L, width: 1920, height: 1080, current, description: c.text, hasScreenshot: false }) }],
    }),
  });
  } catch (e) {
    // 逾時或連線失敗：記一筆就換下一句
    console.log(`#${c.id} FAIL network ${String(e.name ?? e)}  ${c.text}`);
    results.push({ ...c, check: undefined, verdict: `FAIL network ${String(e.name ?? e)}` });
    continue;
  }
  const ms = Math.round(performance.now() - t0);
  const body = await res.json();
  const text = body.choices?.[0]?.message?.content ?? "";
  let verdict;
  try {
    const v = JSON.parse(text.replace(/^```[a-z]*\s*|\s*```$/g, ""));
    if (v.refused) verdict = c.refuse ? "PASS refused" : `FAIL refused:${v.refused}`;
    else if (c.refuse) verdict = "FAIL should refuse";
    else {
      const merged = { ...current, ...v, keys: v.keys.map((k) => ({ anchor: "start", t: 0, rx: 0, ry: 0, rz: 0, size: 1, px: 0, py: 0, ease: "inOut", ...k })) };
      let times = "ok";
      try { P.keyTimes(merged, L); } catch { times = "not-increasing"; }
      const path = P.pathValid(merged.keys, merged.float, 1920, 1080);
      const dir = c.check(merged);
      verdict = `${times === "ok" && path && dir ? "PASS" : "FAIL"} times=${times} path=${path} direction=${dir}`;
    }
  } catch (e) {
    verdict = `FAIL ${String(e.message ?? e).slice(0, 80)}`;
  }
  console.log(`#${c.id} ${verdict}  ${(ms / 1000).toFixed(1)}s  ${body.usage?.total_tokens ?? "?"}tok  ${c.text}`);
  results.push({ ...c, check: undefined, ms, usage: body.usage, verdict, text });
}
const out = join(ROOT, "logs", `plane3d-probe-${model.name}.json`);
writeFileSync(out, JSON.stringify({ model, at: new Date().toISOString(), results }, null, 2));
console.log(`${results.filter((r) => r.verdict.startsWith("PASS")).length}/${results.length} 通過；結果 ${out}`);
