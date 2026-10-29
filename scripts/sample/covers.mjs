// 範例專案的片頭封面（docs/plan-10-29-sample.md S1）：Muse Image /v1/images/generations 生 8 張 16:9 封面（不含字），
// 存到 samples/sample-covers/（gitignore；打包腳本 e2e/sample-build.spec.ts 匯入後才寫進 public/sample/）。
// 執行（PowerShell，repo 根目錄）：node scripts/sample/covers.mjs     已經有的檔不重生；要重生先刪掉。
// 需要：.env 的 META_API_KEY（只讀進行程，不印出）、WORDBLADE_MODEL_IMAGE。費用約 US$0.01／張。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "samples", "sample-covers");

/** 讀 .env */
function loadEnv() {
  const text = readFileSync(join(ROOT, ".env"), "utf-8");
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes("=") && !l.trimStart().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
}

/** 封面主題（和範例片的內容相關：寫一個用 AI 整理會議筆記的命令列工具） */
const COVERS = [
  "a glowing terminal window with green command line output on a dark desk at night",
  "a stack of handwritten meeting notes and sticky notes beside a laptop, warm lamp light",
  "an abstract neural network made of light trails, deep blue and violet",
  "close-up of a mechanical keyboard with RGB backlight, shallow depth of field",
  "a cozy home office with two monitors showing code, plants and soft morning light",
  "a futuristic robot assistant sorting paper documents into neat piles",
  "a whiteboard covered in colorful diagrams and arrows in a bright meeting room",
  "a cup of coffee next to a notebook and a laptop on a wooden table, top-down view",
];
const STYLE = "Cinematic photo, vivid colors, high contrast. No text, no letters, no logos, no watermarks.";

const env = loadEnv();
mkdirSync(OUT, { recursive: true });
/** 生一張（已經有就略過） */
async function one(prompt, i) {
  const file = join(OUT, `cover-${String(i + 1).padStart(2, "0")}.webp`);
  if (existsSync(file)) return `skip ${file}`;
  const t0 = Date.now();
  const res = await fetch("https://api.meta.ai/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${env.META_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: env.WORDBLADE_MODEL_IMAGE, prompt: `${prompt}. ${STYLE}`, size: "1792x1024", n: 1 }),
  });
  const json = await res.json().catch(() => null);
  const b64 = json?.data?.[0]?.b64_json;
  if (!res.ok || !b64) return `FAIL ${i + 1} ${res.status} ${JSON.stringify(json?.error ?? json).slice(0, 200)}`;
  writeFileSync(file, Buffer.from(b64, "base64"));
  return `ok ${file} ${Date.now() - t0} ms`;
}

// 一次 4 張
for (let i = 0; i < COVERS.length; i += 4) {
  const results = await Promise.all(COVERS.slice(i, i + 4).map((p, k) => one(p, i + k)));
  for (const r of results) console.log(r);
}
