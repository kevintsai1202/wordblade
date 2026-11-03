// Muse Image 材質實測（spec §5.12，P1-14，2026-11-01）：用閘道同一個模板產生 3 種材質（木頭、黑板、金屬），
// 存原圖到 output/texture-probe/，給本機後處理（去暗角、無縫化、法線）實機比對；也記尺寸與耗時。
// 執行（PowerShell，repo 根目錄）：node scripts/texture/probe-texture.mjs
// 需要：.env 的 META_API_KEY（只讀進行程，不印出）、WORDBLADE_MODEL_IMAGE。每張約 US$0.01。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "output", "texture-probe");
const BASE = "https://api.meta.ai/v1";
/** 和閘道 PublishJobs.TEXTURE_SUFFIX 相同 */
const SUFFIX = ", seamless tileable texture, flat top-down orthographic view, even diffuse lighting, no shadows, no perspective, no objects, no text, edge to edge";
const PROMPTS = { wood: "worn oak planks", chalkboard: "dark green chalkboard with chalk dust", metal: "brushed steel plate with fine scratches" };

/** 讀 .env */
function loadEnv() {
  const text = readFileSync(join(ROOT, ".env"), "utf-8");
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes("=") && !l.trimStart().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
}

const env = loadEnv();
mkdirSync(OUT, { recursive: true });
const result = {};
await Promise.all(Object.entries(PROMPTS).map(async ([name, prompt]) => {
  const t0 = Date.now();
  const res = await fetch(`${BASE}/images/generations`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.META_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: env.WORDBLADE_MODEL_IMAGE, prompt: prompt + SUFFIX, size: "1024x1024" }),
  });
  const json = await res.json().catch(() => null);
  const b64 = json?.data?.[0]?.b64_json;
  const ext = json?.output_format ?? "png";
  if (b64) writeFileSync(join(OUT, `${name}.${ext}`), Buffer.from(b64, "base64"));
  result[name] = { status: res.status, ms: Date.now() - t0, format: ext, bytes: b64 ? Buffer.from(b64, "base64").length : 0, usage: json?.usage ?? null };
  console.log(name, res.status, result[name].ms, "ms", ext);
}));
writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2));
