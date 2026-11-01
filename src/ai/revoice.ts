// AI 重配音（spec §5.6）的前處理與長度配合：挑講者的聲音樣本（seed）、組成一個 WAV、把 AI 念出來的長度貼進選的範圍。
// 想法移植自 transcript-review 的 tts.py（auto_seed_ranges／build_seed／synthesize）；純函式為主，抽音訊與打閘道由呼叫端傳進來，方便測試。
import { concatWav, parseWav } from "../asr/wav";
import { joinWords, timelineWords } from "../core/captions";
import type { Media, Project, Seconds, Word } from "../core/model";
import { sourceOfVocals } from "../core/stems";
import { clipDuration } from "../core/timeline";

/** 樣本長度的設定（秒）：原專案要 60 秒，範例專案很短，所以最少放寬到 20 秒；盡量湊到 60～90 秒 */
export const SEED_MIN: Seconds = 20;
export const SEED_TARGET: Seconds = 60;
export const SEED_MAX: Seconds = 90;
/** 兩個詞之間空超過這麼久就算分成兩段話（秒） */
const SPEECH_GAP: Seconds = 0.6;

/** 一段連續的講話（素材時間） */
export interface Span {
  start: Seconds;
  end: Seconds;
}

/** 挑好的樣本：音訊（WAV）、對應的文字、總長 */
export interface Seed {
  wav: Uint8Array;
  text: string;
  seconds: Seconds;
}

/** 逐字稿的詞 → 連續講話的區段（詞與詞的空隙不超過 gap 秒就接在一起），依時間排序 */
export function speechSpans(words: Word[], gap: Seconds = SPEECH_GAP): Span[] {
  const sorted = [...words].sort((a, b) => a.start - b.start);
  const spans: Span[] = [];
  for (const w of sorted) {
    const last = spans[spans.length - 1];
    if (last && w.start - last.end <= gap) last.end = Math.max(last.end, w.end);
    else spans.push({ start: w.start, end: w.end });
  }
  return spans;
}

/**
 * 由長到短挑講話區段，累計到 target 秒為止；單段最多取到 cap 秒的剩餘額度（超過就截尾）。
 * 總長不到 min 秒回 null（說話太少，克隆不出像樣的聲音）。回傳依時間排序，音訊與文字都照這個順序接。
 */
export function pickSeedSpans(spans: Span[], opts: { min?: Seconds; target?: Seconds; cap?: Seconds } = {}): Span[] | null {
  const { min = SEED_MIN, target = SEED_TARGET, cap = SEED_MAX } = opts;
  const picked: Span[] = [];
  let total = 0;
  for (const s of [...spans].sort((a, b) => b.end - b.start - (a.end - a.start))) {
    if (total >= target) break;
    const end = Math.min(s.end, s.start + (cap - total));
    if (end <= s.start) continue;
    picked.push({ start: s.start, end });
    total += end - s.start;
  }
  if (total < min) return null;
  return picked.sort((a, b) => a.start - b.start);
}

/** 落在區段內的詞接成文字（詞的中點在區段裡才算，截尾時不會多帶半個詞） */
export function spanText(words: Word[], span: Span): string {
  return joinWords(words.filter((w) => (w.start + w.end) / 2 >= span.start && (w.start + w.end) / 2 < span.end).sort((a, b) => a.start - b.start).map((w) => w.text));
}

/** 時間軸範圍內的逐字稿（V1 上詞的中點落在範圍裡的詞接成文字），當作重配音文字框的預設內容 */
export function rangeText(project: Project, range: { start: Seconds; end: Seconds }): string {
  return joinWords(timelineWords(project).filter((w) => (w.start + w.end) / 2 >= range.start && (w.start + w.end) / 2 < range.end).map((w) => w.text));
}

/** 已經建好的樣本（本次執行期間，依素材 id 快取；重新轉錄逐字稿不會自動換掉，重開 app 才重建） */
const seedCache = new Map<string, Seed>();

/** 清掉樣本快取（測試用） */
export function clearSeedCache() {
  seedCache.clear();
}

/**
 * 由主對白素材建講者的聲音樣本：挑講話區段 → 逐段抽 16 kHz 單聲道 WAV → 接成一個 WAV；樣本文字是這些區段裡的詞。
 * 說話總長不到 SEED_MIN 或沒有文字時丟錯。extract 是引擎的 extractAsrAudio；
 * 素材已分離出人聲（Media.stems，§5.14）時，呼叫端的 extract 要改從人聲抽（core/stems 的 audioSourceFor），逐字稿仍用這支素材的。
 */
export async function buildSeed(media: Media, words: Word[], extract: (media: Media, start: Seconds, end: Seconds) => Promise<Uint8Array>): Promise<Seed> {
  const cached = seedCache.get(media.id);
  if (cached) return cached;
  const mine = words.filter((w) => w.mediaId === media.id);
  const spans = pickSeedSpans(speechSpans(mine));
  if (!spans) throw new Error("Need at least 20 seconds of transcribed speech");
  // 文字是 Fish 對齊樣本音訊用的，空的會讓輸出長度失控（tts.py 的教訓）
  const text = spans.map((s) => spanText(mine, s)).filter(Boolean).join(" ");
  if (!text) throw new Error("Need at least 20 seconds of transcribed speech");
  const wav = concatWav(await Promise.all(spans.map((s) => extract(media, s.start, s.end))));
  const info = parseWav(wav);
  const seed: Seed = { wav, text, seconds: info.data.length / (info.rate * info.channels * (info.bits >> 3)) };
  seedCache.set(media.id, seed);
  return seed;
}

/**
 * 主對白素材：對白軌（role="dialogue"）上用得最久的素材；對白軌沒有片段就看 V1 上有聲音的影片。
 * 要複製的是主講者的聲音，所以不看配樂與音效；沒有可用的素材回 null。
 * 對白軌放的是分離後的人聲素材時，回它的原素材（逐字稿與 stems 都記在原素材上）。
 */
export function dialogueMedia(project: Project): Media | null {
  const dialogueTracks = new Set(project.tracks.filter((t) => t.kind === "audio" && t.role === "dialogue").map((t) => t.id));
  const v1 = project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
  const usable = (id: string) => project.media.find((m) => m.id === id && m.audio !== false && m.kind !== "image" && !m.offline) ?? null;
  for (const onTrack of [(id: string) => dialogueTracks.has(id), (id: string) => id === v1]) {
    const use = new Map<string, number>();
    for (const c of project.clips) if (onTrack(c.trackId) && usable(c.mediaId)) use.set(c.mediaId, (use.get(c.mediaId) ?? 0) + clipDuration(c));
    const best = [...use.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best) {
      const found = usable(best[0]);
      return found && sourceOfVocals(project, found);
    }
  }
  return null;
}

/** 一次念出來的結果 */
export interface Spoken {
  audio: Uint8Array;
  seconds: Seconds;
}

/** 配合長度的結果：要放的聲音、片段要再套的倍速（1＝不用） */
export interface Fitted extends Spoken {
  clipSpeed: number;
}

/** 念出來的長度超過範圍多少秒以內算剛好（秒） */
const FIT_TOLERANCE: Seconds = 0.05;
/** 請模型加快語速的上限 */
const MAX_TTS_SPEED = 1.3;
/** 片段變速的上限（和 setClipSpeed 的 MAX_SPEED 一致） */
const MAX_CLIP_SPEED = 4;

/**
 * 把 AI 念出來的長度貼進範圍 target 秒：先用原速念；太長就請模型加快語速重念一次（上限 1.3 倍、多給 2% 餘裕）；
 * 還是太長就回傳片段倍速（念出的長度 ÷ target，上限 4）由時間軸變速（保持音高）。比範圍短的不動。
 */
export async function fitToRange(speak: (speed: number) => Promise<Spoken>, target: Seconds): Promise<Fitted> {
  const first = await speak(1);
  if (!(target > 0) || first.seconds <= target + FIT_TOLERANCE) return { ...first, clipSpeed: 1 };
  const second = await speak(Math.min(MAX_TTS_SPEED, (first.seconds / target) * 1.02));
  if (second.seconds <= target + FIT_TOLERANCE) return { ...second, clipSpeed: 1 };
  return { ...second, clipSpeed: Math.min(MAX_CLIP_SPEED, second.seconds / target) };
}
