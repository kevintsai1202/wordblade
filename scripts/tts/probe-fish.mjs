// Fish Audio 即時克隆實測（spec §5.6，P2，2026-11-01）：和閘道 TtsJobs 同一套契約——model 放 header、本體 msgpack、
// references 帶 raw bytes 的樣本 WAV＋樣本文字、format wav。樣本取 samples/demo-2min.mp4 的 10～40 秒（ffmpeg 解成 44.1 kHz 單聲道）。
// 執行（PowerShell，repo 根目錄）：node scripts/tts/probe-fish.mjs
// 需要：.env 的 FISH_API_KEY（只讀進行程，不印出）；PATH 上有 ffmpeg。結果：output/tts-probe/（樣本、生成的 WAV、result.json）
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "output", "tts-probe");
mkdirSync(OUT, { recursive: true });

/** 讀 .env */
function loadEnv() {
  const text = readFileSync(join(ROOT, ".env"), "utf-8");
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes("=") && !l.trimStart().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
}

/** 最小 msgpack 編碼器（和閘道 MsgPack.java 一樣的子集） */
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

const env = loadEnv();
const seed = execFileSync("ffmpeg", ["-v", "error", "-ss", "10", "-t", "30", "-i", join(ROOT, "samples", "demo-2min.mp4"), "-vn", "-ac", "1", "-ar", "44100", "-f", "wav", "-"], { maxBuffer: 1 << 26 });
writeFileSync(join(OUT, "seed.wav"), seed);
const seedText = "Here's the kind of notes I mean. Just a few bullet points from our weekly sync. Nothing fancy, just plain markdown that anyone on the team can write. First I'll create a new folder and install two packages, the OpenAI client and dotenv.";
const body = pack({ text: "Now let's write the main script. [break] It only takes a minute.", references: [{ audio: new Uint8Array(seed), text: seedText }], format: "wav", temperature: 0.7, normalize: true, prosody: { speed: 1 } });
const t0 = Date.now();
const res = await fetch("https://api.fish.audio/v1/tts", { method: "POST", headers: { authorization: `Bearer ${env.FISH_API_KEY}`, "content-type": "application/msgpack", model: "s2.1-pro-free" }, body });
const bytes = Buffer.from(await res.arrayBuffer());
const result = { status: res.status, ms: Date.now() - t0, bytes: bytes.length, head: bytes.subarray(0, 4).toString("latin1"), riffSize: bytes.length > 8 ? bytes.readUInt32LE(4) : null };
if (res.ok) writeFileSync(join(OUT, "out.wav"), bytes);
else result.error = bytes.toString("utf8").slice(0, 300);
writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
