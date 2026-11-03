// Demo 影片英文旁白（docs/demo-script.md）：用作者本人的聲音樣本（Fish 即時克隆）逐句生成。
// 模型預設 drama-3（付費、情緒控制較強，開發者 2026-11-03 指定；只用在 demo 旁白，app 仍一律 s2.1-pro-free）；
// $env:WORDBLADE_DEMO_TTS_MODEL="s2.1-pro-free" 可切回免費版比較。注意：model 標頭打錯時 Fish 不報錯、會靜默回退 s2.1-pro。
// 每句帶 S2 的方括號語氣提示（[excited]、[break] 等）；同一句（文字＋樣本）有快取，改稿只重念改到的句子。
// 執行（PowerShell，repo 根目錄）：node scripts/tts/demo-narration.mjs [句子編號，逗號分隔，省略＝全部]
// 需要：.env 的 FISH_API_KEY（只讀進行程，不印出）；PATH 上有 ffmpeg。
// 樣本：$env:WORDBLADE_VOICE_SEED 指定的資料夾裡的 seed.wav＋seed.json（text 欄是樣本逐字稿；作者本人的錄音，不進版控）。
// 產出：output/demo-voice/<模型>/NN.wav（每句）、preview.wav（全部接起來，句間 0.4 秒）
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "output", "demo-voice");
/** 聲音樣本資料夾（seed.wav＋seed.json 的 text） */
const SEED_DIR = process.env.WORDBLADE_VOICE_SEED;
if (!SEED_DIR) throw new Error("請用 $env:WORDBLADE_VOICE_SEED 指定聲音樣本資料夾（裡面要有 seed.wav 與 seed.json）");
/** Fish 模型 */
const MODEL = process.env.WORDBLADE_DEMO_TTS_MODEL ?? "drama-3";
/** 產出資料夾依模型分開，方便比較 */
const DIR = join(OUT, MODEL);

/** 旁白稿：一句一筆，id 對應 docs/demo-script.md 的段落 */
const LINES = [
  { id: "01", text: "[low, confident] Every effect you\"re about to see [break] was written by an AI. [short pause] From one sentence." },
  { id: "02", text: "[building excitement] And this entire video? [break] [proud, with a smile] Edited by WordBlade." },
  { id: "03", text: "[tired, honest] I record coding tutorials. And turning a raw take like this into something I can actually publish [break] takes me hours." },
  { id: "04", text: "[frustrated] Cutting retakes. Hiding secrets. Captions. Motion. [sigh] Every single time." },
  { id: "05", text: "[energetic] So I built WordBlade. [break] You edit the video by editing words, and Meta\"s models do the heavy lifting." },
  { id: "06", text: "[clear, explaining] Muse Voice Transcribe gives me the transcript. I rebuild word-level timing from the audio, [break] so deleting a word cuts the video." },
  { id: "07", text: "[impressed] Then the AI director watches the whole recording. Muse Wonder plans, Muse Spark reviews every segment, [break] and it hands me a list: retakes to cut, a leaked key to hide, places to zoom in." },
  { id: "08", text: "[satisfied] I accept them, one by one." },
  { id: "09", text: "[playful] Oops, that\"s my API key. [break] I just type what it is, and SAM 3.1 finds it and tracks it through the clip." },
  { id: "10", text: "[excited, leaning in] Now, the part I\"m most excited about. [break] I describe an effect, and Muse Wonder writes a brand new animation plugin. In 2D, [short pause] or in 3D with three.js." },
  { id: "11", text: "[amazed] It runs in a sandbox, and it can see the frame, the transcript, and everything SAM found." },
  { id: "12", text: "[smooth, cinematic] 3D scenes put my video on a screen in a room. I describe the camera move in plain words, [break] and the camera follows." },
  { id: "13", text: "[fast, upbeat] Karaoke captions. Sound effects and music written as code. Re-voicing a line in my own voice. A title and a thumbnail from Muse Image. [break] And export." },
  { id: "14", text: "[proud] Preview and export share the same compositor, so what I see is exactly what I get." },
  { id: "15", text: "[warm, confident] From a raw take to a publishable video, in minutes, not hours. [break] [inviting] Try it in your browser. No install needed." },
];

/** 讀 .env */
function loadEnv() {
  const text = readFileSync(join(ROOT, ".env"), "utf-8");
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes("=") && !l.trimStart().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
}

/** 最小 msgpack 編碼器（和閘道 MsgPack.java、probe-fish.mjs 同一個子集） */
function pack(v) {
  const out = [];
  const be = (n, bytes) => { for (let i = bytes - 1; i >= 0; i--) out.push(Number((BigInt(n) >> BigInt(8 * i)) & 0xffn)); };
  const put = (x) => {
    if (x === null) out.push(0xc0);
    else if (typeof x === "boolean") out.push(x ? 0xc3 : 0xc2);
    else if (typeof x === "number" && Number.isInteger(x) && x >= 0 && x < 128) out.push(x);
    else if (typeof x === "number") { out.push(0xcb); const b = Buffer.alloc(8); b.writeDoubleBE(x); out.push(...b); }
    else if (typeof x === "string") { const b = Buffer.from(x, "utf8"); if (b.length < 32) out.push(0xa0 | b.length); else if (b.length < 256) out.push(0xd9, b.length); else { out.push(0xda); be(b.length, 2); } out.push(...b); }
    else if (x instanceof Uint8Array) { if (x.length < 256) out.push(0xc4, x.length); else if (x.length < 65536) { out.push(0xc5); be(x.length, 2); } else { out.push(0xc6); be(x.length, 4); } for (const c of x) out.push(c); }
    else if (Array.isArray(x)) { out.push(0x90 | x.length); x.forEach(put); }
    else { const e = Object.entries(x); out.push(0x80 | e.length); for (const [k, val] of e) { put(k); put(val); } }
  };
  put(v);
  return Uint8Array.from(out);
}

/** 串流 WAV 的長度欄位是錯的（0xFFFFFFFF），依實際長度改寫 RIFF 與 data 區塊大小 */
function fixWav(buf) {
  const b = Buffer.from(buf);
  if (b.toString("latin1", 0, 4) !== "RIFF") return b;
  b.writeUInt32LE(b.length - 8, 4);
  const at = b.indexOf("data", 12, "latin1");
  if (at > 0) b.writeUInt32LE(b.length - at - 8, at + 4);
  return b;
}

const env = loadEnv();
if (!env.FISH_API_KEY) throw new Error(".env 沒有 FISH_API_KEY");
mkdirSync(DIR, { recursive: true });
const seed = readFileSync(join(SEED_DIR, "seed.wav"));
const seedText = JSON.parse(readFileSync(join(SEED_DIR, "seed.json"), "utf-8")).text;
const only = process.argv[2]?.split(",");
const seedHash = createHash("sha1").update(seed).digest("hex").slice(0, 8);

for (const line of LINES) {
  if (only && !only.includes(line.id)) continue;
  const key = createHash("sha1").update(`${seedHash}|${MODEL}|${line.text}`).digest("hex").slice(0, 12);
  const cache = join(DIR, `cache-${key}.wav`);
  if (!existsSync(cache)) {
    const t0 = Date.now();
    const body = pack({ text: line.text, references: [{ audio: new Uint8Array(seed), text: seedText }], format: "wav", temperature: 0.7, normalize: true, prosody: { speed: 1 } });
    const res = await fetch("https://api.fish.audio/v1/tts", { method: "POST", headers: { authorization: `Bearer ${env.FISH_API_KEY}`, "content-type": "application/msgpack", model: MODEL }, body });
    const bytes = Buffer.from(await res.arrayBuffer());
    if (!res.ok) throw new Error(`Fish ${res.status}：${bytes.toString("utf8").slice(0, 300)}`);
    writeFileSync(cache, fixWav(bytes));
    console.log(`${line.id}：生成 ${((Date.now() - t0) / 1000).toFixed(1)} 秒`);
  }
  writeFileSync(join(DIR, `${line.id}.wav`), readFileSync(cache));
}

// 全部接起來試聽（句間 0.4 秒靜音）
const files = LINES.map((l) => join(DIR, `${l.id}.wav`)).filter(existsSync);
const inputs = files.flatMap((f) => ["-i", f]);
const chain = files.map((_, i) => `[${i}:a]aresample=44100,aformat=channel_layouts=mono,apad=pad_dur=0.4[a${i}]`).join(";");
const concat = files.map((_, i) => `[a${i}]`).join("") + `concat=n=${files.length}:v=0:a=1[out]`;
execFileSync("ffmpeg", ["-v", "error", "-y", ...inputs, "-filter_complex", `${chain};${concat}`, "-map", "[out]", join(DIR, "preview.wav")]);
console.log(`已存 output/demo-voice/${MODEL}/preview.wav（${files.length} 句）`);
