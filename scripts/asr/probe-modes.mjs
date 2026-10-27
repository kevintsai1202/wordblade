// Muse Voice Transcribe 的模式偵測（spec §5.2）：同一段音訊分別用 DIARIZATION、ENDPOINTING（JSON）以及 DELTA 串流（SSE）送一次，
// 比較 turn 的長度與數量、串流事件的種類與間隔；素材旁有 .truth.json（scripts/demo-sample/make.mjs）時，另外量
// 「每句第一個字出現在哪個 DELTA 事件、那個事件的 audioProcessedMs 比句子起點晚多少」。
//
// 執行（PowerShell，repo 根目錄）：node scripts/asr/probe-modes.mjs samples/demo-2min.mp4 [samples/fosdem-covid-3min.mp4 …]
// 需要：.env 的 META_API_KEY（只讀進行程，不印出）；PATH 上有 ffmpeg。每支素材 ≤ 10 分鐘（整段送一次，不切段）。
// 結果：output/asr-modes-<素材名>.json（含原始 turns 與事件；終端只印統計）
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** repo 根目錄 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ENDPOINT = "https://api.meta.ai/v1/asr/transcribe";

/** 讀 .env */
function loadEnv() {
  const text = readFileSync(join(ROOT, ".env"), "utf-8");
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes("=") && !l.trimStart().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
}

/** 素材 → 16 kHz 單聲道 16-bit WAV 位元組 */
function toWav(file) {
  return execFileSync("ffmpeg", ["-v", "error", "-i", file, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "-f", "wav", "-"], { maxBuffer: 1 << 30 });
}

/** 送一次；accept 決定回 JSON 或 SSE */
async function send(env, wav, request, accept) {
  const fd = new FormData();
  fd.append("request", new Blob([JSON.stringify({ model: env.WORDBLADE_MODEL_ASR || "muse-voice-transcribe-1.0", audioEncoding: "WAV", ...request })], { type: "application/json" }));
  fd.append("audio", new Blob([wav], { type: "audio/wav" }), "audio.wav");
  const t0 = performance.now();
  const res = await fetch(ENDPOINT, { method: "POST", headers: { authorization: `Bearer ${env.META_API_KEY}`, accept }, body: fd });
  const body = await res.text();
  const seconds = (performance.now() - t0) / 1000;
  if (!res.ok) return { status: res.status, seconds, error: body.slice(0, 300) };
  if (accept === "application/json") return { status: res.status, seconds, json: JSON.parse(body) };
  // SSE：每個事件一行 data: {...}
  const events = body.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => JSON.parse(l.slice(5).trim()));
  return { status: res.status, seconds, events };
}

/** 一組數字的統計 */
function stats(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, mean: +mean.toFixed(2), median: +s[Math.floor(s.length / 2)].toFixed(2), max: +s[s.length - 1].toFixed(2), min: +s[0].toFixed(2) };
}

/** 比對用：小寫、去標點 */
const bare = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, "");

/** 偵測一支素材 */
async function probe(env, file) {
  const name = basename(file).replace(/\.[^.]+$/, "");
  const wav = toWav(file);
  const out = { file, seconds: (wav.length - 44) / 32000 };
  for (const mode of ["DIARIZATION", "ENDPOINTING"]) {
    const r = await send(env, wav, { mode }, "application/json");
    const turns = r.json?.turns ?? [];
    out[mode] = { status: r.status, requestSeconds: +r.seconds.toFixed(1), error: r.error, turnLengths: stats(turns.map((t) => (t.endMs - t.startMs) / 1000)), punctuated: turns.filter((t) => /[.?!]/.test(t.transcript)).length, turns };
  }
  // DELTA 串流：事件種類、間隔、每個 transcript 事件的文字長度
  const d = await send(env, wav, { mode: "DIARIZATION", partialMode: "DELTA" }, "text/event-stream");
  const events = d.events ?? [];
  const types = {};
  for (const e of events) types[e.type ?? "?"] = (types[e.type ?? "?"] ?? 0) + 1;
  const transcripts = events.filter((e) => e.type === "transcript" && typeof e.audioProcessedMs === "number");
  const gaps = transcripts.slice(1).map((e, i) => (e.audioProcessedMs - transcripts[i].audioProcessedMs) / 1000);
  out.DELTA = { status: d.status, requestSeconds: +d.seconds.toFixed(1), error: d.error, types, fields: [...new Set(events.flatMap((e) => Object.keys(e)))], gapSeconds: stats(gaps), wordsPerEvent: stats(transcripts.map((e) => (e.transcript ?? "").trim().split(/\s+/).filter(Boolean).length)), events };

  // 有正確答案：每句第一個字落在哪個 DELTA 事件，事件的 audioProcessedMs 比句子起點晚多少（時間上限的延遲）
  const truthFile = file.replace(/\.[^.]+$/, ".truth.json");
  if (existsSync(truthFile) && transcripts.length) {
    const truth = JSON.parse(readFileSync(truthFile, "utf8"));
    // 依序累積字，記每個字所在事件的 audioProcessedMs
    const words = [];
    for (const e of transcripts) for (const w of (e.transcript ?? "").trim().split(/\s+/).filter(Boolean)) words.push({ w: bare(w), at: e.audioProcessedMs / 1000 });
    const lags = [];
    let from = 0;
    for (const s of truth.sentences) {
      const first = bare(s.text.split(/\s+/)[0]);
      const i = words.findIndex((x, k) => k >= from && x.w === first && x.at >= s.start - 1);
      if (i < 0) continue;
      lags.push(+(words[i].at - s.start).toFixed(2));
      from = i + 1;
    }
    out.deltaLagVsTruth = { matched: lags.length, of: truth.sentences.length, lagSeconds: stats(lags), lags };
  }
  mkdirSync(join(ROOT, "output"), { recursive: true });
  writeFileSync(join(ROOT, "output", `asr-modes-${name}.json`), JSON.stringify(out, null, 2));
  // 終端只印統計
  const brief = (m) => m.error ? `HTTP ${m.status} ${m.error}` : `${m.requestSeconds}s, turns ${JSON.stringify(m.turnLengths)}, 有句號的 turn ${m.punctuated}`;
  console.log(`\n== ${name}（${out.seconds.toFixed(1)} 秒）`);
  console.log(`DIARIZATION: ${brief(out.DIARIZATION)}`);
  console.log(`ENDPOINTING: ${brief(out.ENDPOINTING)}`);
  console.log(`DELTA: ${d.error ? `HTTP ${d.status} ${d.error}` : `${out.DELTA.requestSeconds}s, 事件 ${JSON.stringify(types)}, 欄位 ${out.DELTA.fields.join("/")}, 間隔 ${JSON.stringify(out.DELTA.gapSeconds)}, 每事件字數 ${JSON.stringify(out.DELTA.wordsPerEvent)}`}`);
  if (out.deltaLagVsTruth) console.log(`DELTA 句首延遲（事件時間 − 句子起點）：${JSON.stringify(out.deltaLagVsTruth.lagSeconds)}，對上 ${out.deltaLagVsTruth.matched}/${out.deltaLagVsTruth.of}`);
}

const env = loadEnv();
if (!env.META_API_KEY) throw new Error(".env 沒有 META_API_KEY");
for (const f of process.argv.slice(2)) await probe(env, resolve(f));
