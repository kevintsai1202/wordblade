// 素材庫與新專案（spec §4、§5.13）：純函式。素材的規格由 Engine 讀好（ffprobe／mediabunny）後當普通資料傳進來。
import { produce } from "immer";
import type { Media, Project, Seconds, Track, Word } from "./model";

/** 圖片素材的「長度」：圖片沒有長度，給一個夠長的值讓修邊可以拉長 */
export const IMAGE_DURATION: Seconds = 24 * 3600;

/** 建一條軌道 */
function track(id: string, kind: Track["kind"], index: number, role?: Track["role"]): Track {
  return { id, kind, index, ...(role ? { role } : {}), muted: false, locked: false, volume: 1 };
}

/** 新的空專案：V1 主軌、V2 疊加軌、A1 對白、A2 配樂、A3 音效（§5.13） */
export function emptyProject(): Project {
  return {
    media: [],
    tracks: [
      track("V1", "video", 0),
      track("V2", "video", 1),
      track("A1", "audio", 0, "dialogue"),
      track("A2", "audio", 1, "music"),
      track("A3", "audio", 2, "sfx"),
    ],
    clips: [],
    words: [],
    captionBreaks: [],
    masks: [],
    effects: [],
    anchors: [],
    suggestions: [],
    plugins: [],
    synths: [],
    stems: [],
  };
}

/** 把素材加進素材庫；id 已經在的略過 */
export function addMedia(project: Project, media: Media[]): Project {
  const fresh = media.filter((m) => !project.media.some((x) => x.id === m.id));
  if (fresh.length === 0) return project;
  return produce(project, (draft) => {
    draft.media.push(...fresh);
  });
}

/** 改某支素材的欄位（例如代理檔做好時記 proxyPath）；找不到就原樣回傳 */
export function patchMedia(project: Project, id: string, patch: Partial<Omit<Media, "id">>): Project {
  if (!project.media.some((m) => m.id === id)) return project;
  return produce(project, (draft) => {
    Object.assign(draft.media.find((m) => m.id === id)!, patch);
  });
}

/**
 * 換掉某支素材的整份逐字稿（Muse ASR 轉錄完，§5.2）：其他素材的詞不動，新的詞依起點排序；
 * 指到被換掉的詞的字幕斷點（CaptionBreak）一起刪掉。
 */
export function setMediaWords(project: Project, mediaId: string, words: Word[]): Project {
  const removed = new Set(project.words.filter((w) => w.mediaId === mediaId).map((w) => w.id));
  return produce(project, (draft) => {
    draft.words = [...draft.words.filter((w) => w.mediaId !== mediaId), ...[...words].sort((a, b) => a.start - b.start)];
    draft.captionBreaks = draft.captionBreaks.filter((b) => !removed.has(b.wordId));
  });
}
