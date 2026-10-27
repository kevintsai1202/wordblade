// 產生英文配音的測試影片：把原專案（transcript-review）的中文錄課影片，
// 用 Muse Spark 把逐字稿翻成英文、Fish Audio 唸成英文，換掉原本的人聲。
// 用途：10/27 匯出量測（D24）的 11 分鐘多軌素材，以及之後英文字幕、斷句的開發素材。
//
// 執行（PowerShell）：
//   node scripts/make-english-sample.mjs                     # 兩支都做，已完成的步驟走快取
//   node scripts/make-english-sample.mjs --only lecture-a    # 只做一支
//   node scripts/make-english-sample.mjs --retranslate       # 重新翻譯（會覆蓋 work/*.en.json）
//   node scripts/make-english-sample.mjs --voice <reference_id>
//
// 需要：.env 的 META_API_KEY、FISH_API_KEY、WORDBLADE_MODEL_SPARK；PATH 上有 ffmpeg／ffprobe。
// 產出（都在 samples/，不進版控）：
//   <id>.en.mp4、<id>.en.srt（實際配音時間）、bench-11min.mp4（兩支串接）
//   work/<id>.en.json（翻譯結果，可手改後重跑）、work/tts/（Fish 回傳的音檔快取）

import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** repo 根目錄 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** 產出目錄與中間檔目錄 */
const OUT_DIR = join(ROOT, 'samples');
const WORK_DIR = join(OUT_DIR, 'work');
const TTS_DIR = join(WORK_DIR, 'tts');

/** 原專案的測試樣本（只讀不改） */
const SOURCE_DIR = resolve(ROOT, '..', 'transcript-review', 'samples');
/** 要轉的影片：id → 原檔名（不含副檔名）；兩支都有現成的 SRT */
const SOURCES = [
  { id: 'lecture-a', name: '2026-09-06 10-34-10' },
  { id: 'lecture-b', name: '2026-09-09 07-43-21' },
];

/** Fish Audio 設定：免費模型＋公開聲音庫的英文旁白音色（Ethan：male, middle-aged, educational, narration） */
const FISH_API = 'https://api.fish.audio';
const FISH_MODEL = 's2.1-pro-free';
const DEFAULT_VOICE = '536d3a5e000945adb7038665781a4aca';

/** 配音的混音參數 */
const SAMPLE_RATE = 48000; // 輸出音軌取樣率（單聲道 16-bit）
const MAX_SPEEDUP = 1.35; // 英文比原句長時最多加速到 1.35 倍，再長就讓它往後延
const MIN_GAP = 0.15; // 兩句之間至少留 0.15 秒

// ── 共用工具 ────────────────────────────────────────────

/** 讀 .env（KEY=VALUE，忽略空行與註解） */
function loadEnv() {
  const text = readFileSync(join(ROOT, '.env'), 'utf-8');
  return Object.fromEntries(text.split(/\r?\n/)
    .filter(l => l.includes('=') && !l.trimStart().startsWith('#'))
    .map(l => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]));
}

/** 解析命令列參數 */
function parseArgs(argv) {
  const args = { only: null, retranslate: false, voice: DEFAULT_VOICE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--only') args.only = argv[++i];
    else if (argv[i] === '--retranslate') args.retranslate = true;
    else if (argv[i] === '--voice') args.voice = argv[++i];
    else throw new Error(`不認得的參數：${argv[i]}`);
  }
  return args;
}

/** 印出帶時間的進度訊息 */
function log(...parts) {
  console.log(new Date().toISOString().slice(11, 19), ...parts);
}

/** 執行 ffmpeg／ffprobe，失敗時把 stderr 一起丟出 */
function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'buffer', maxBuffer: 1 << 30, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new Error(`${cmd} 失敗：${e.stderr?.toString().slice(-2000)}`);
  }
}

/** 用 ffprobe 取影片長度（秒） */
function probeDuration(file) {
  return Number(run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString().trim());
}

/** 帶重試的 fetch：429 與 5xx 依序等 2、5、10 秒再試 */
async function fetchRetry(url, init, label) {
  const waits = [2000, 5000, 10000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, init);
    if (res.ok) return res;
    const body = await res.text();
    if ((res.status === 429 || res.status >= 500) && attempt < waits.length) {
      log(`${label} 回 ${res.status}，${waits[attempt] / 1000} 秒後重試`);
      await new Promise(r => setTimeout(r, waits[attempt]));
      continue;
    }
    throw new Error(`${label} 失敗 ${res.status}：${body.slice(0, 500)}`);
  }
}

// ── SRT ────────────────────────────────────────────────

/** SRT 時間字串（00:00:03,220）轉秒 */
function srtTimeToSec(t) {
  const [h, m, rest] = t.split(':');
  const [s, ms] = rest.split(',');
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms) / 1000;
}

/** 秒轉 SRT 時間字串 */
function secToSrtTime(sec) {
  const ms = Math.round(sec * 1000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** 解析 SRT，回傳 [{ start, end, text }]（依出現順序） */
function parseSrt(text) {
  return text.replace(/^\uFEFF/, '').split(/\r?\n\r?\n/).map(block => block.trim().split(/\r?\n/))
    .filter(lines => lines.length >= 3 && lines[1].includes('-->'))
    .map(lines => {
      const [a, b] = lines[1].split('-->').map(s => s.trim());
      return { start: srtTimeToSec(a), end: srtTimeToSec(b), text: lines.slice(2).join(' ').trim() };
    });
}

// ── 翻譯（Muse Spark） ──────────────────────────────────

/** 翻譯結果的 JSON Schema：把連續的片段併成句子再翻成英文 */
const TRANSLATION_SCHEMA = {
  type: 'object',
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          from: { type: 'integer' }, // 這句的第一個片段編號
          to: { type: 'integer' }, // 這句的最後一個片段編號（含）
          en: { type: 'string' }, // 英文；純贅詞的句子給空字串
        },
        required: ['from', 'to', 'en'],
        additionalProperties: false,
      },
    },
  },
  required: ['groups'],
  additionalProperties: false,
};

/** 給 Muse Spark 的指示 */
const TRANSLATION_PROMPT = `You will receive Chinese subtitle fragments from an ASR system, taken from a software tutorial screen recording.
Fragments are numbered from 0. They may break mid-sentence, overlap slightly, contain mis-recognized words, and contain fillers (啊, 呃, 嗯, 那個).

Task:
1. Group consecutive fragments into natural spoken sentences. Every fragment must belong to exactly one group, in order: the first group starts at 0, each next group starts right after the previous one ends, the last group ends at the last fragment.
2. Translate each group into natural, spoken American English, as the instructor would say it in an English tutorial. Fix obvious ASR mistakes from context.
3. Translate faithfully and completely. Do NOT summarize or condense: keep every point, example and aside the speaker makes.
4. Match the original speaking time: aim for about 2.3 English words per second of the group's duration (given in seconds), e.g. a 10-second group needs about 23 words. Never exceed 2.8 words per second.
5. Drop pure fillers. If a group is only fillers or noise, set "en" to an empty string.
Return JSON only.`;

/** 檢查 Spark 回的分組是否連續、完整覆蓋所有片段；有問題回傳錯誤訊息 */
function validateGroups(groups, count) {
  let next = 0;
  for (const g of groups) {
    if (g.from !== next) return `group starting at ${g.from} should start at ${next}`;
    if (g.to < g.from || g.to >= count) return `group ${g.from}-${g.to} is out of range`;
    next = g.to + 1;
  }
  return next === count ? null : `groups end at ${next - 1}, but the last fragment is ${count - 1}`;
}

/** 呼叫 Muse Spark 翻譯一支影片的所有片段；分組不合格時帶錯誤訊息重問一次 */
async function translate(env, segments) {
  const lines = segments.map((s, i) => `${i} [${s.start.toFixed(2)}-${s.end.toFixed(2)}] ${s.text}`).join('\n');
  const messages = [
    { role: 'system', content: TRANSLATION_PROMPT },
    { role: 'user', content: lines },
  ];
  for (let round = 0; round < 2; round++) {
    const res = await fetchRetry('https://api.meta.ai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.META_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: env.WORDBLADE_MODEL_SPARK,
        messages,
        reasoning_effort: 'low',
        response_format: { type: 'json_schema', json_schema: { name: 'translation', strict: true, schema: TRANSLATION_SCHEMA } },
      }),
    }, 'Muse Spark');
    const data = await res.json();
    const content = data.choices[0].message.content;
    const { groups } = JSON.parse(content);
    const error = validateGroups(groups, segments.length);
    if (!error) {
      log(`翻譯完成：${segments.length} 個片段 → ${groups.length} 句；tokens ${data.usage?.total_tokens}`);
      return groups;
    }
    log(`分組不合格（${error}），帶錯誤重問`);
    messages.push({ role: 'assistant', content }, { role: 'user', content: `Invalid grouping: ${error}. Return the full corrected JSON.` });
  }
  throw new Error('Muse Spark 兩次都回了不合格的分組');
}

// ── 配音（Fish Audio） ──────────────────────────────────

/** 一句英文唸成 WAV，依「音色＋模型＋文字」快取；回傳檔案路徑 */
async function synthesize(env, voice, text) {
  const hash = createHash('sha1').update(`${voice}|${FISH_MODEL}|${text}`).digest('hex').slice(0, 16);
  const file = join(TTS_DIR, `${hash}.wav`);
  if (existsSync(file)) return file;
  const res = await fetchRetry(`${FISH_API}/v1/tts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.FISH_API_KEY}`, 'Content-Type': 'application/json', model: FISH_MODEL },
    body: JSON.stringify({ text, reference_id: voice, format: 'wav', normalize: true, latency: 'normal' }),
  }, 'Fish TTS');
  writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  return file;
}

/** 把音檔轉成 48 kHz 單聲道 16-bit PCM；speed > 1 時用 atempo 加速（保持音高） */
function toPcm(file, speed = 1) {
  const filters = speed > 1.001 ? ['-af', `atempo=${speed.toFixed(4)}`] : [];
  const buf = run('ffmpeg', ['-v', 'error', '-i', file, ...filters, '-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1']);
  return new Int16Array(buf.buffer, buf.byteOffset, buf.length >> 1);
}

/** 以固定並行數跑一批非同步工作 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: limit }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** 單聲道 16-bit PCM 包成 WAV 檔 */
function writeWav(file, pcm) {
  const header = Buffer.alloc(44);
  const dataBytes = pcm.length * 2;
  header.write('RIFF', 0); header.writeUInt32LE(36 + dataBytes, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(dataBytes, 40);
  writeFileSync(file, Buffer.concat([header, Buffer.from(pcm.buffer, pcm.byteOffset, dataBytes)]));
}

// ── 主流程 ──────────────────────────────────────────────

/** 處理一支影片：翻譯 → 配音 → 排時間 → 合成新音軌 → 換掉原音 */
async function processVideo(env, args, src) {
  const video = join(SOURCE_DIR, `${src.name}.mp4`);
  const segments = parseSrt(readFileSync(join(SOURCE_DIR, `${src.name}.srt`), 'utf-8'));
  const duration = probeDuration(video);
  log(`${src.id}：${src.name}，${duration.toFixed(1)} 秒，${segments.length} 個字幕片段`);

  // 1. 翻譯（結果存檔，可以手改後重跑）
  const transFile = join(WORK_DIR, `${src.id}.en.json`);
  let groups;
  if (existsSync(transFile) && !args.retranslate) {
    groups = JSON.parse(readFileSync(transFile, 'utf-8')).groups;
    log(`沿用翻譯 ${transFile}`);
  } else {
    groups = await translate(env, segments);
    writeFileSync(transFile, JSON.stringify({ source: src.name, groups: groups.map(g => ({
      ...g, start: segments[g.from].start, end: segments[g.to].end,
      zh: segments.slice(g.from, g.to + 1).map(s => s.text).join(''),
    })) }, null, 2));
  }

  // 2. 配音（並行 3 句；Fish 免費模型不保證速度）
  const spoken = groups.filter(g => g.en.trim());
  let done = 0;
  const files = await mapLimit(spoken, 3, async g => {
    const file = await synthesize(env, args.voice, g.en.trim());
    if (++done % 10 === 0 || done === spoken.length) log(`配音 ${done}/${spoken.length}`);
    return file;
  });

  // 3. 排時間：每句從原句開頭開始；比可用時間長就加速（最多 MAX_SPEEDUP），再長就往後延
  const track = new Int16Array(Math.ceil(duration * SAMPLE_RATE));
  const placed = [];
  let prevEnd = 0;
  spoken.forEach((g, i) => {
    const t = Math.max(segments[g.from].start, prevEnd + MIN_GAP);
    const nextStart = i + 1 < spoken.length ? segments[spoken[i + 1].from].start : duration;
    let pcm = toPcm(files[i]);
    const available = nextStart - MIN_GAP - t;
    const len = pcm.length / SAMPLE_RATE;
    let speed = 1;
    if (available > 0 && len > available) {
      speed = Math.min(len / available, MAX_SPEEDUP);
      pcm = toPcm(files[i], speed);
    }
    const offset = Math.round(t * SAMPLE_RATE);
    const fit = Math.max(0, Math.min(pcm.length, track.length - offset));
    if (fit < pcm.length) log(`警告：最後一句超出片尾 ${((pcm.length - fit) / SAMPLE_RATE).toFixed(2)} 秒，已截掉`);
    track.set(pcm.subarray(0, fit), offset);
    prevEnd = t + pcm.length / SAMPLE_RATE;
    placed.push({ start: t, end: prevEnd, text: g.en.trim(), speed });
  });
  const drift = placed.map((p, i) => p.start - segments[spoken[i].from].start);
  log(`排時間完成：加速 ${placed.filter(p => p.speed > 1).length} 句，最大延後 ${Math.max(...drift).toFixed(2)} 秒`);
  // 覆蓋率：英文配音總長 ÷ 原句總長，太低代表翻譯被濃縮了
  const zhSec = groups.reduce((sum, g) => sum + segments[g.to].end - segments[g.from].start, 0);
  const enSec = placed.reduce((sum, p) => sum + p.end - p.start, 0);
  log(`覆蓋率：英文 ${enSec.toFixed(0)} 秒 ÷ 原句 ${zhSec.toFixed(0)} 秒 = ${(enSec / zhSec * 100).toFixed(0)}%`);

  // 4. 寫英文音軌、英文 SRT，換掉原音
  const wav = join(WORK_DIR, `${src.id}.en.wav`);
  writeWav(wav, track);
  writeFileSync(join(OUT_DIR, `${src.id}.en.srt`), placed.map((p, i) =>
    `${i + 1}\n${secToSrtTime(p.start)} --> ${secToSrtTime(p.end)}\n${p.text}\n`).join('\n'));
  const out = join(OUT_DIR, `${src.id}.en.mp4`);
  run('ffmpeg', ['-v', 'error', '-y', '-i', video, '-i', wav, '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-ar', String(SAMPLE_RATE), '-t', duration.toFixed(3), out]);
  log(`完成 ${out}`);
  return out;
}

/** 把兩支英文影片串成一支約 11 分鐘的量測素材（同規格，直接複製串流） */
function concatBench(outputs) {
  const list = join(WORK_DIR, 'bench-list.txt');
  writeFileSync(list, outputs.map(f => `file '${f.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const out = join(OUT_DIR, 'bench-11min.mp4');
  run('ffmpeg', ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', out]);
  log(`量測素材 ${out}（${probeDuration(out).toFixed(1)} 秒）`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const env = loadEnv();
  for (const key of ['META_API_KEY', 'FISH_API_KEY', 'WORDBLADE_MODEL_SPARK']) {
    if (!env[key]) throw new Error(`.env 缺少 ${key}`);
  }
  mkdirSync(TTS_DIR, { recursive: true });
  const targets = SOURCES.filter(s => !args.only || s.id === args.only);
  const outputs = [];
  for (const src of targets) outputs.push(await processVideo(env, args, src));
  if (outputs.length === SOURCES.length) concatBench(outputs);
}

main().catch(e => { console.error(e.message); process.exit(1); });
