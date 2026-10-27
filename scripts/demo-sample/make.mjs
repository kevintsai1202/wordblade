// 產生模擬的 D30 範例短片（spec §5.22、§5.2）：英文旁白（Fish Audio）＋仿 VS Code 的螢幕錄影（Playwright 逐格截圖），
// 同時輸出正確答案，給 ASR 英文實測、語助詞實測、SAM 遮罩（假 API 金鑰）與 AI 導演（講錯重講）用。
//
// 執行（PowerShell，repo 根目錄）：node scripts/demo-sample/make.mjs
// 需要：.env 的 FISH_API_KEY；PATH 上有 ffmpeg／ffprobe；Playwright 的 Chromium。
// 產出（samples/，不進版控）：
//   demo-2min.mp4      1920×1080 30 fps H.264＋AAC
//   demo-2min.srt      逐句字幕（實際配音時間）
//   demo-2min.truth.json  正確答案：每句起訖與文字、語助詞、重講段落、金鑰出現的時間與位置
//   work/demo-tts/     Fish 回傳的音檔快取（改講稿只重唸改到的句子）
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { FAKE_KEY, FILES, INITIAL, LINES } from "./script.mjs";

/** repo 根目錄與產出位置 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "samples");
const TTS_DIR = join(OUT, "work", "demo-tts");
const FRAMES = join(OUT, "work", "demo-frames");
const NAME = "demo-2min";

/** Fish Audio：和 make-english-sample.mjs 同一個免費模型與英文旁白音色（Ethan） */
const FISH_API = "https://api.fish.audio";
const FISH_MODEL = "s2.1-pro-free";
const VOICE = "536d3a5e000945adb7038665781a4aca";

/** 輸出規格 */
const FPS = 30;
const RATE = 48000;
/** 片頭留白（秒） */
const LEAD = 0.8;

/** 印一行紀錄 */
function log(...parts) {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

/** 讀 .env */
function loadEnv() {
  const text = readFileSync(join(ROOT, ".env"), "utf-8");
  return Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes("=") && !l.trimStart().startsWith("#")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
}

/** 執行 ffmpeg／ffprobe，失敗時帶 stderr */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "buffer", maxBuffer: 1 << 30, stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    throw new Error(`${cmd} 失敗：${e.stderr?.toString().slice(-2000)}`);
  }
}

/** 一句唸成 WAV（依音色＋模型＋文字快取） */
async function synthesize(env, text) {
  const hash = createHash("sha1").update(`${VOICE}|${FISH_MODEL}|${text}`).digest("hex").slice(0, 16);
  const file = join(TTS_DIR, `${hash}.wav`);
  if (existsSync(file)) return file;
  for (const wait of [0, 2000, 5000, 10000]) {
    if (wait) await new Promise((r) => setTimeout(r, wait));
    const res = await fetch(`${FISH_API}/v1/tts`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.FISH_API_KEY}`, "Content-Type": "application/json", model: FISH_MODEL },
      body: JSON.stringify({ text, reference_id: VOICE, format: "wav", normalize: true, latency: "normal" }),
    });
    if (res.ok) {
      writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      return file;
    }
    if (res.status !== 429 && res.status < 500) throw new Error(`Fish TTS ${res.status}：${(await res.text()).slice(0, 300)}`);
  }
  throw new Error("Fish TTS 重試耗盡");
}

/** 音檔 → 48 kHz 單聲道 16-bit PCM，去掉頭尾的靜音（句與句的間隔由講稿的 gap 決定） */
function toPcm(file) {
  const trim = "silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse,silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.05,areverse";
  const buf = run("ffmpeg", ["-v", "error", "-i", file, "-af", trim, "-f", "s16le", "-ac", "1", "-ar", String(RATE), "pipe:1"]);
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
}

/** 秒 → SRT 時間 */
function srtTime(sec) {
  const ms = Math.round(sec * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** 單聲道 PCM 寫成 WAV */
function writeWav(file, pcm) {
  const header = Buffer.alloc(44);
  const bytes = pcm.length * 2;
  header.write("RIFF", 0); header.writeUInt32LE(36 + bytes, 4); header.write("WAVE", 8);
  header.write("fmt ", 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(RATE, 24); header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36); header.writeUInt32LE(bytes, 40);
  writeFileSync(file, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, bytes)]));
}

/** 主流程 */
async function main() {
  const env = loadEnv();
  if (!env.FISH_API_KEY) throw new Error(".env 沒有 FISH_API_KEY");
  mkdirSync(TTS_DIR, { recursive: true });

  // 1. 配音（3 句並行），排時間：每句接在前一句之後＋gap
  log(`配音 ${LINES.length} 句`);
  const files = new Array(LINES.length);
  let next = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (next < LINES.length) {
      const i = next++;
      files[i] = await synthesize(env, LINES[i].text);
    }
  }));
  const pcms = files.map(toPcm);
  const events = [];
  let t = LEAD;
  for (const [i, line] of LINES.entries()) {
    const dur = pcms[i].length / RATE;
    events.push({ index: i, start: t, end: t + dur, text: line.text, fillers: line.fillers, retake: !!line.retake, actions: line.actions });
    t += dur + line.gap;
  }
  const total = t;
  log(`總長 ${total.toFixed(1)} 秒`);

  // 2. 旁白音軌
  const narration = new Int16Array(Math.ceil(total * RATE));
  for (const [i, ev] of events.entries()) narration.set(pcms[i], Math.round(ev.start * RATE));
  const wav = join(OUT, "work", `${NAME}.narration.wav`);
  writeWav(wav, narration);

  // 3. 畫面：逐格算畫面，簽章變了才截圖；記每張圖要停幾格
  rmSync(FRAMES, { recursive: true, force: true });
  mkdirSync(FRAMES, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(pathToFileURL(join(ROOT, "scripts", "demo-sample", "screen.html")).href);
  await page.evaluate((tl) => window.setTimeline(tl), { files: FILES, initial: INITIAL, events: events.map(({ start, end, actions }) => ({ start, end, actions })) });
  const frames = Math.ceil(total * FPS);
  /** [{ file, count }]：每張截圖連續用幾格 */
  const shots = [];
  let last = null;
  /** 金鑰出現的時間與位置（第一次看得到到最後一次） */
  let keyShown = null;
  for (let f = 0; f < frames; f++) {
    const sig = await page.evaluate((s) => window.renderAt(s), f / FPS);
    if (sig !== last) {
      const file = join(FRAMES, `${String(shots.length).padStart(5, "0")}.png`);
      await page.screenshot({ path: file });
      shots.push({ file, count: 1 });
      last = sig;
      const box = await page.evaluate(() => {
        const el = document.getElementById("api-key");
        if (!el || !el.textContent.length) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x / 1920, y: r.y / 1080, w: r.width / 1920, h: r.height / 1080, full: el.textContent.length };
      });
      if (box) {
        keyShown ??= { start: f / FPS, end: f / FPS, box };
        keyShown.end = (f + 1) / FPS;
        if (box.full >= FAKE_KEY.length) keyShown.box = box;
      }
    } else {
      shots[shots.length - 1].count++;
      if (keyShown && keyShown.end === f / FPS) keyShown.end = (f + 1) / FPS;
    }
  }
  await browser.close();
  log(`截圖 ${shots.length} 張（${frames} 格）`);

  // 4. 合成：concat 清單（每張停 count 格）＋旁白 → MP4
  const list = join(FRAMES, "list.txt");
  writeFileSync(list, shots.map((s) => `file '${s.file.replace(/\\/g, "/")}'\nduration ${(s.count / FPS).toFixed(6)}`).join("\n") + `\nfile '${shots[shots.length - 1].file.replace(/\\/g, "/")}'\n`);
  const mp4 = join(OUT, `${NAME}.mp4`);
  run("ffmpeg", ["-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list, "-i", wav,
    "-vf", `fps=${FPS},format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-g", String(FPS),
    "-c:a", "aac", "-b:a", "160k", "-t", total.toFixed(3), "-movflags", "+faststart", mp4]);

  // 5. 正確答案：SRT 與 truth.json
  writeFileSync(join(OUT, `${NAME}.srt`), events.map((ev, i) => `${i + 1}\r\n${srtTime(ev.start)} --> ${srtTime(ev.end)}\r\n${ev.text}\r\n`).join("\r\n"));
  const truth = {
    note: "模擬的 D30 範例短片（TTS，非真人）；時間是實際配音的起訖（秒）",
    duration: Number(total.toFixed(3)),
    sentences: events.map((ev) => ({ start: Number(ev.start.toFixed(3)), end: Number(ev.end.toFixed(3)), text: ev.text, fillers: ev.fillers, retake: ev.retake })),
    fillers: events.flatMap((ev) => ev.fillers.map((word) => ({ word, sentence: ev.index }))),
    retake: (() => {
      const r = events.filter((ev) => ev.retake);
      return { start: Number(r[0].start.toFixed(3)), end: Number(r[r.length - 1].end.toFixed(3)), note: "講錯重講：這段要剪掉，接著的下一句是正確版本" };
    })(),
    apiKey: keyShown && { text: FAKE_KEY, start: Number(keyShown.start.toFixed(3)), end: Number(keyShown.end.toFixed(3)), box: keyShown.box },
  };
  writeFileSync(join(OUT, `${NAME}.truth.json`), JSON.stringify(truth, null, 2));
  log(`完成 ${mp4}（${total.toFixed(1)} 秒、語助詞 ${truth.fillers.length} 個、金鑰 ${truth.apiKey?.start.toFixed(1)}～${truth.apiKey?.end.toFixed(1)} 秒）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
