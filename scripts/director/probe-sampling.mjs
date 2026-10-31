// 探測 Muse 模型收不收 temperature／seed（docs/plan-10-31-director4.md）：推理模型在 OpenAI 相容 API 常對 temperature 回 400。
// 對 Wonder（reasoning_effort medium）與 Spark（low）各送：① 不帶 ② temperature 0＋seed 1，再用 ② 連送兩次比對回應是否一樣。
// 金鑰與模型 ID 從 repo 的 .env 讀（不印出）。用法（repo 根目錄）：node scripts/director/probe-sampling.mjs
import { readFileSync } from "node:fs";

/** .env → 物件（只取有值的） */
const env = Object.fromEntries(readFileSync(".env", "utf8").split(/\r?\n/).map((l) => /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
const BASE = (env.WORDBLADE_META_BASE_URL ?? "https://api.meta.ai") + "/v1/chat/completions";
/** 固定的小題目：回一個 JSON，內容有一點自由度（看得出隨機性） */
const PROMPT = "Reply with JSON only: {\"names\":[five creative names for a video editing app]}";

/** 送一次；回 HTTP 狀態與文字 */
async function ask(model, reasoning, extra) {
  const res = await fetch(BASE, {
    method: "POST",
    headers: { authorization: `Bearer ${env.META_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model, reasoning_effort: reasoning, response_format: { type: "json_object" }, messages: [{ role: "user", content: PROMPT }], ...extra }),
  });
  const body = await res.text();
  let text = body;
  try { text = JSON.parse(body).choices?.[0]?.message?.content ?? body; } catch { /* 錯誤訊息原樣 */ }
  return { status: res.status, text: text.replace(/\s+/g, " ").slice(0, 200) };
}

for (const [label, model, reasoning] of [["wonder", env.WORDBLADE_MODEL_WONDER, "medium"], ["spark", env.WORDBLADE_MODEL_SPARK, "low"]]) {
  const plain = await ask(model, reasoning, {});
  const a = await ask(model, reasoning, { temperature: 0, seed: 1 });
  const b = a.status === 200 ? await ask(model, reasoning, { temperature: 0, seed: 1 }) : null;
  console.log(`${label}: 不帶 → ${plain.status}；temperature 0＋seed 1 → ${a.status}${b ? `，兩次相同：${a.text === b.text}` : ""}`);
  console.log(`  ${a.text}`);
  if (b) console.log(`  ${b.text}`);
}
