// 產生發佈包（spec §5.17）：成片逐字稿分行（太長從中間截掉）→ 閘道（Muse Spark）→ 章節對齊送出去的行首、套 YouTube 規則。
import type { GatewayKit } from "../ai/gateway";
import type { TimelineWord } from "../core/captions";
import { detectLanguage, normalizeChapters, transcriptLines, trimLines, type PublishKit, type TranscriptLine } from "./kit";

/** 送給閘道的逐字稿最多幾個字元（閘道上限 6 萬，留時間標記的空間） */
const MAX_CHARS = 50_000;

/** 寫發佈包的服務（GatewayClient.publishKit；測試換假的） */
export interface KitService {
  publishKit(body: { language: string; duration: number; lines: TranscriptLine[] }): Promise<GatewayKit>;
}

/**
 * 產生發佈包。words：成片的詞（timelineWords）；duration：成片長度；language：不給就依逐字稿判斷。
 * 回傳發佈包與要給使用者看的提示（逐字稿被截過、章節不夠 YouTube 不顯示）。
 */
export async function generateKit(service: KitService, words: TimelineWord[], duration: number, language?: string): Promise<{ kit: PublishKit; notice: string | null }> {
  const all = transcriptLines(words);
  if (!all.length) throw new Error("Transcribe the video first — the publish kit is written from the transcript.");
  const { lines, trimmed } = trimLines(all, MAX_CHARS);
  const lang = language ?? detectLanguage(all.map((l) => l.text).join(" "));
  const reply = await service.publishKit({ language: lang, duration, lines });
  const chapters = normalizeChapters(reply.chapters, lines.map((l) => l.t), duration);
  const notes: string[] = [];
  if (trimmed) notes.push("The transcript was long, so the middle part was left out.");
  if (!chapters.length) notes.push("No chapters: YouTube needs at least 3, each 10 s or longer.");
  return {
    kit: { language: lang, titles: reply.titles, title: 0, description: reply.description, highlights: reply.highlights, chapters, tags: reply.tags },
    notice: notes.length ? notes.join(" ") : null,
  };
}
