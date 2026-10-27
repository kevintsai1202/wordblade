// 改字（spec §4、§5.1）：手改字幕的文字就是改那幾個 Word.text；改完詞數變了，就把新文字重新分詞，
// 在原本那幾個詞的總時間內依字數比例分配，舊詞換成新詞。刪字是改字即剪（cutWords），不走這裡。
import { produce } from "immer";
import type { Project } from "./model";
import { tokenize } from "./text";

/** 毫秒精度 */
const ms = (t: number) => Math.round(t * 1000) / 1000;

/**
 * 把同一支素材裡連續的幾個詞換成 text（空字串、不連續、跨素材時不改，回傳原物件）。
 * 詞數不變時保留 id 與時間（字幕斷點跟著留）；詞數變了就重新分配時間，新 id 從被換掉的第一個 id 衍生，指到舊詞的斷點刪掉。
 */
export function editWords(project: Project, wordIds: string[], text: string): Project {
  const tokens = tokenize(text);
  if (!tokens.length || !wordIds.length) return project;
  const chosen = project.words.filter((w) => wordIds.includes(w.id));
  if (chosen.length !== new Set(wordIds).size) return project;
  const mediaId = chosen[0].mediaId;
  if (chosen.some((w) => w.mediaId !== mediaId)) return project;
  // 必須是這支素材裡連續的詞
  const all = project.words.filter((w) => w.mediaId === mediaId).sort((a, b) => a.start - b.start);
  const idx = chosen.map((w) => all.findIndex((x) => x.id === w.id)).sort((a, b) => a - b);
  if (idx.some((v, i) => i && v !== idx[i - 1] + 1)) return project;
  const old = idx.map((i) => all[i]);
  if (tokens.length === old.length) {
    return produce(project, (draft) => {
      old.forEach((w, i) => { draft.words.find((x) => x.id === w.id)!.text = tokens[i]; });
    });
  }
  // 詞數變了：在 [第一個詞的起點, 最後一個詞的結尾] 內依字數比例分配
  const start = old[0].start;
  const end = old[old.length - 1].end;
  const weights = tokens.map((t) => Math.max(1, t.replace(/[\p{P}\p{S}]/gu, "").length));
  const total = weights.reduce((a, b) => a + b, 0);
  const existing = new Set(project.words.map((w) => w.id));
  let acc = 0;
  const fresh = tokens.map((t, k) => {
    const s = start + ((end - start) * acc) / total;
    acc += weights[k];
    // 新 id：被換掉的第一個 id 加序號；萬一撞到就再加尾碼
    let id = `${old[0].id}/${k}`;
    while (existing.has(id) && !old.some((w) => w.id === id)) id += "'";
    return { id, mediaId, text: t, start: ms(s), end: ms(start + ((end - start) * acc) / total) };
  });
  const removed = new Set(old.map((w) => w.id));
  return produce(project, (draft) => {
    draft.words = [...draft.words.filter((w) => !removed.has(w.id)), ...fresh].sort((a, b) => a.start - b.start);
    draft.captionBreaks = draft.captionBreaks.filter((b) => !removed.has(b.wordId));
  });
}
