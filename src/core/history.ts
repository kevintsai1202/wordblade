// 編輯與復原／重做（spec §4）：編輯是資料（Edit），commit 一次可以帶多個編輯但只留一筆歷史，
// 例如「去贅詞 Remove all」、AI 導演採用一條建議，都只要一次 Ctrl+Z（§5.11、§5.16）。
// 歷史存的是整份專案的快照；timeline 的函式用 Immer 做結構共享，快照之間沒改到的部分是同一個物件。
import { addEffect, deleteEffect, moveEffect, setEffectCameraKeys, setEffectParams, trimEffect } from "./effects";
import type { CameraKey, DirectorChapter, Effect, MaskObject, Plugin, Project, Seconds, Suggestion, Synth, Word, ZoomRegion } from "./model";
import { setSuggestionStatus, setSuggestions } from "./suggestions";
import { addMasks, deleteMasks, setMask } from "./masks";
import { setCaptionStyle, setMediaWords } from "./media";
import { editWords } from "./transcriptEdit";
import { addZoom, deleteZoom, setZoom } from "./zoom";
import { setClipSpeed } from "./speed";
import { insertIntro, type IntroInsert } from "../intro/insert";
import type { CaptionStyle } from "../captions/captionLayout";
import { cutByWords, cutSourceRanges, deleteClip, layoutV1, moveClip, placeLoop, placeMedia, rippleDelete, splitClip, trimClip, type SourceRange } from "./timeline";

/** 一個編輯動作 */
export type Edit =
  | { kind: "rippleDelete"; a: Seconds; b: Seconds }
  | { kind: "cutWords"; wordIds: string[] }
  | { kind: "split"; clipId: string; t: Seconds }
  | { kind: "trim"; clipId: string; edge: "in" | "out"; t: Seconds }
  | { kind: "move"; clipId: string; start: Seconds }
  | { kind: "delete"; clipId: string }
  | { kind: "place"; mediaId: string; trackId: string; t: Seconds }
  | { kind: "placeLoop"; mediaId: string; trackId: string; t: Seconds; end: Seconds }
  | { kind: "addSynth"; synth: Synth }
  | { kind: "removeMedia"; mediaId: string }
  | { kind: "addEffect"; effect: Effect; plugins: Plugin[] }
  | { kind: "moveEffect"; effectId: string; start: Seconds }
  | { kind: "trimEffect"; effectId: string; edge: "in" | "out"; t: Seconds }
  | { kind: "deleteEffect"; effectId: string }
  | { kind: "setEffectParams"; effectId: string; params: Record<string, unknown> }
  | { kind: "setCameraKeys"; effectId: string; keys: CameraKey[] }
  | { kind: "setWords"; mediaId: string; words: Word[] }
  | { kind: "setCaptionStyle"; style: Partial<CaptionStyle> }
  | { kind: "editWords"; wordIds: string[]; text: string }
  | { kind: "cutRanges"; ranges: SourceRange[] }
  | { kind: "addZoom"; zoom: ZoomRegion }
  | { kind: "setZoom"; zoom: ZoomRegion }
  | { kind: "deleteZoom"; zoomId: string }
  | { kind: "setSpeed"; clipId: string; speed: number }
  | { kind: "addMasks"; masks: MaskObject[] }
  | { kind: "setMask"; mask: MaskObject }
  | { kind: "deleteMasks"; ids: string[] }
  | { kind: "setSuggestions"; mediaId: string; suggestions: Suggestion[]; chapters?: DirectorChapter[] }
  | { kind: "setSuggestionStatus"; id: string; status: Suggestion["status"] }
  | { kind: "insertIntro"; intro: IntroInsert };

/** 套用一個編輯 */
function applyEdit(project: Project, edit: Edit): Project {
  switch (edit.kind) {
    case "rippleDelete": return rippleDelete(project, edit.a, edit.b);
    case "cutWords": return cutByWords(project, edit.wordIds);
    case "split": return splitClip(project, edit.clipId, edit.t);
    case "trim": return trimClip(project, edit.clipId, edit.edge, edit.t);
    case "move": return moveClip(project, edit.clipId, edit.start);
    case "delete": return deleteClip(project, edit.clipId);
    case "place": return placeMedia(project, edit.mediaId, edit.trackId, edit.t);
    case "placeLoop": return placeLoop(project, edit.mediaId, edit.trackId, edit.t, edit.end);
    case "removeMedia": return removeMedia(project, edit.mediaId);
    case "addSynth": return { ...project, synths: [...(project.synths ?? []).filter((x) => x.id !== edit.synth.id), edit.synth] };
    case "addEffect": return addEffect(project, edit.effect, edit.plugins);
    case "insertIntro": return insertIntro(project, edit.intro);
    case "moveEffect": return moveEffect(project, edit.effectId, edit.start);
    case "trimEffect": return trimEffect(project, edit.effectId, edit.edge, edit.t);
    case "deleteEffect": return deleteEffect(project, edit.effectId);
    case "setEffectParams": return setEffectParams(project, edit.effectId, edit.params);
    case "setCameraKeys": return setEffectCameraKeys(project, edit.effectId, edit.keys);
    case "setWords": return setMediaWords(project, edit.mediaId, edit.words);
    case "setCaptionStyle": return setCaptionStyle(project, edit.style);
    case "editWords": return editWords(project, edit.wordIds, edit.text);
    case "cutRanges": return cutSourceRanges(project, edit.ranges);
    case "addZoom": return addZoom(project, edit.zoom);
    case "setZoom": return setZoom(project, edit.zoom);
    case "deleteZoom": return deleteZoom(project, edit.zoomId);
    case "addMasks": return addMasks(project, edit.masks);
    case "setMask": return setMask(project, edit.mask);
    case "deleteMasks": return deleteMasks(project, edit.ids);
    case "setSuggestions": return setSuggestions(project, edit.mediaId, edit.suggestions, edit.chapters);
    case "setSuggestionStatus": return setSuggestionStatus(project, edit.id, edit.status);
    case "setSpeed": return setClipSpeed(project, edit.clipId, edit.speed);
  }
}

/** 依序套用多個編輯；全部沒改到就回傳原物件 */
export function applyEdits(project: Project, edits: Edit[]): Project {
  return edits.reduce(applyEdit, project);
}

/** 歷史：過去的快照、目前、可重做的快照 */
export interface History {
  past: Project[];
  present: Project;
  future: Project[];
}

/** 從一份專案開始一段歷史 */
export function createHistory(project: Project): History {
  return { past: [], present: project, future: [] };
}

/** 套用一組編輯並留一筆歷史；沒有改變就不留，新的 commit 會清掉可重做的部分 */
export function commit(history: History, edits: Edit[]): History {
  const next = applyEdits(history.present, edits);
  if (next === history.present) return history;
  return { past: [...history.past, history.present], present: next, future: [] };
}

/**
 * 不進復原歷史的修改（例如匯入素材）：套到過去、目前、未來每一份快照，
 * 這樣 Ctrl+Z 不會把匯入的素材變不見，復原到的舊狀態也看得到它。
 */
export function amend(history: History, change: (project: Project) => Project): History {
  return { past: history.past.map(change), present: change(history.present), future: history.future.map(change) };
}

/** 能不能復原 */
export function canUndo(history: History): boolean {
  return history.past.length > 0;
}

/** 能不能重做 */
export function canRedo(history: History): boolean {
  return history.future.length > 0;
}

/** 復原一步 */
export function undo(history: History): History {
  if (!canUndo(history)) return history;
  const previous = history.past[history.past.length - 1];
  return { past: history.past.slice(0, -1), present: previous, future: [history.present, ...history.future] };
}

/** 重做一步 */
export function redo(history: History): History {
  if (!canRedo(history)) return history;
  const [next, ...rest] = history.future;
  return { past: [...history.past, history.present], present: next, future: rest };
}

/**
 * 從專案移除素材（2026-11-01）：素材、它在時間軸上的片段、逐字稿、遮罩、AI 建議與章節、音效規格的連結一起拿掉；
 * V1 拿掉片段後重新接起來（不留空隙），其他軌不動。素材檔本身不動（專案只記連結）。
 */
function removeMedia(project: Project, mediaId: string): Project {
  if (!project.media.some((m) => m.id === mediaId)) return project;
  const removed = new Set(project.clips.filter((c) => c.mediaId === mediaId).map((c) => c.id));
  let p: Project = {
    ...project,
    media: project.media.filter((m) => m.id !== mediaId),
    words: project.words.filter((w) => w.mediaId !== mediaId),
    masks: project.masks.filter((m) => m.mediaId !== mediaId),
    suggestions: project.suggestions.filter((s) => s.mediaId !== mediaId),
    synths: (project.synths ?? []).map((x) => (x.renderedMediaId === mediaId ? { ...x, renderedMediaId: undefined } : x)),
    ...(project.directorChapters ? { directorChapters: project.directorChapters.filter((c) => c.mediaId !== mediaId) } : {}),
  };
  // 只拿掉這支素材的片段（不用漣漪刪除：那會連帶剪掉其他軌上別的素材）；V1 再重新接起來
  p = { ...p, clips: p.clips.filter((c) => !removed.has(c.id)) };
  return layoutV1(p);
}
