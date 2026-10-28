// 介面狀態（主畫面共用）：專案歷史、播放頭、選取的片段、時間軸縮放。
// reducer 與熱鍵對應都是純函式，方便單元測試；React 端只負責把事件轉成動作。
import { amend, commit, createHistory, redo, undo, type Edit, type History } from "../core/history";
import { addMedia, patchMedia } from "../core/media";
import type { Media, Project, Seconds } from "../core/model";
import { clipEnd } from "../core/timeline";
import { roundTime } from "../core/time";

/** 時間軸的格率（之後改成依專案設定） */
export const FPS = 30;

/** 主畫面狀態 */
export interface AppState {
  history: History;
  /** 播放頭（時間軸秒） */
  playhead: Seconds;
  selectedClipId: string | null;
  /** 選取的特效（和片段互斥） */
  selectedEffectId: string | null;
  /** 時間軸縮放：每秒幾像素 */
  pxPerSecond: number;
  /** 是否在播放 */
  playing: boolean;
  /** 播放速度：正的前進、負的倒退（J／L 連按 1、2、4、8 倍） */
  rate: number;
  /** 試聽：播到這個時間自動停（null：不限） */
  stopAt?: Seconds | null;
  /** 每次開始播放遞增：預覽的播放迴圈依它重起（先 seek 再 play 時 playing、rate 都沒變，也要從新位置播） */
  playSeq: number;
  /** 時間軸上選的範圍（Shift＋拖曳或 I／O；時間軸秒）：放大、特效、刪除都從它建立（照字導字演） */
  range?: { start: Seconds; end: Seconds } | null;
  /** 按了 I 但還沒有範圍時記住的入點（再按 O 才成為範圍） */
  markIn?: Seconds | null;
}

/** 介面動作 */
export type Action =
  | { type: "commit"; edits: Edit[] }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "seek"; time: Seconds }
  | { type: "select"; clipId: string | null }
  | { type: "selectEffect"; effectId: string | null }
  | { type: "deleteSelected" }
  | { type: "zoom"; pxPerSecond: number }
  | { type: "play"; rate: number; stopAt?: Seconds }
  | { type: "setRange"; start: Seconds; end: Seconds }
  | { type: "clearRange" }
  | { type: "markIn"; time: Seconds }
  | { type: "deleteRange" }
  | { type: "pause" }
  | { type: "tick"; time: Seconds }
  | { type: "importMedia"; media: Media[] }
  | { type: "patchMedia"; id: string; patch: Partial<Omit<Media, "id">> }
  | { type: "load"; project: Project };

/** 從一份專案建立初始狀態 */
export function initialState(project: Project): AppState {
  return { history: createHistory(project), playhead: 0, selectedClipId: null, selectedEffectId: null, pxPerSecond: 20, playing: false, rate: 1, playSeq: 0, range: null, markIn: null };
}

/** 成片長度：所有片段與特效最晚的終點（只有特效、還沒放影片時也要能預覽） */
export function projectDuration(project: Project): Seconds {
  const clips = project.clips.reduce((max, c) => Math.max(max, clipEnd(c)), 0);
  return project.effects.reduce((max, e) => Math.max(max, e.end), clips);
}

/** 秒數轉成「時:分:秒:格」；格數四捨五入，避免浮點誤差讓 floor 卡在前一格 */
export function formatTimecode(t: Seconds, fps: number = FPS): string {
  const totalFrames = Math.round(t * fps);
  const frames = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(totalSeconds / 3600))}:${pad(Math.floor(totalSeconds / 60) % 60)}:${pad(totalSeconds % 60)}:${pad(frames)}`;
}

/** 狀態轉換 */
export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "commit":
      return withValidSelection({ ...state, history: commit(state.history, action.edits) });
    case "undo":
      return withValidSelection({ ...state, history: undo(state.history) });
    case "redo":
      return withValidSelection({ ...state, history: redo(state.history) });
    case "seek": {
      // 播放中被介入（拖播放頭、點軌道或逐字稿、方向鍵）就停在新位置（開發者 2026-10-28）
      const max = projectDuration(state.history.present);
      return { ...state, playhead: roundTime(Math.min(max, Math.max(0, action.time))), playing: false, stopAt: null };
    }
    case "select":
      return { ...state, selectedClipId: action.clipId, selectedEffectId: null };
    case "selectEffect":
      return { ...state, selectedEffectId: action.effectId, selectedClipId: null };
    case "deleteSelected":
      if (state.selectedEffectId) return withValidSelection({ ...state, history: commit(state.history, [{ kind: "deleteEffect", effectId: state.selectedEffectId }]) });
      if (!state.selectedClipId) return state;
      return withValidSelection({ ...state, history: commit(state.history, [{ kind: "delete", clipId: state.selectedClipId }]) });
    case "zoom":
      return { ...state, pxPerSecond: Math.min(400, Math.max(2, action.pxPerSecond)) };
    case "play":
      return { ...state, playing: true, rate: action.rate, stopAt: action.stopAt ?? null, playSeq: state.playSeq + 1 };
    case "pause":
      return { ...state, playing: false };
    case "importMedia":
      // 匯入不進復原歷史：Ctrl+Z 不會讓素材消失
      return { ...state, history: amend(state.history, (p) => addMedia(p, action.media)) };
    case "patchMedia":
      // 代理檔等衍生資訊：同樣不進復原歷史
      return { ...state, history: amend(state.history, (p) => patchMedia(p, action.id, action.patch)) };
    case "load":
      return { ...initialState(action.project), pxPerSecond: state.pxPerSecond };
    case "setRange": {
      // 起訖排序；長度不到一格當作沒有範圍
      const start = roundTime(Math.max(0, Math.min(action.start, action.end)));
      const end = roundTime(Math.max(action.start, action.end));
      return { ...state, range: end - start >= 1 / FPS ? { start, end } : null, markIn: null };
    }
    case "markIn":
      return { ...state, markIn: roundTime(action.time) };
    case "clearRange":
      return { ...state, range: null, markIn: null };
    case "deleteRange": {
      // 漣漪刪掉範圍（§4 跨軌規則），播放頭停在範圍起點
      if (!state.range) return state;
      const { start, end } = state.range;
      return withValidSelection({ ...state, history: commit(state.history, [{ kind: "rippleDelete", a: start, b: end }]), range: null, playhead: start });
    }
    case "tick": {
      // 已經停了（例如剛被 seek 介入）：排在途中的那一格不能把播放頭拉回去
      if (!state.playing) return state;
      // 播放中推進播放頭；走到片尾（前進）或片頭（倒退）就停在那裡
      const max = projectDuration(state.history.present);
      const time = roundTime(Math.min(max, Math.max(0, action.time)));
      const atEdge = (state.rate > 0 && time >= max) || (state.rate < 0 && time <= 0);
      // 試聽：播到 stopAt 就停在那裡
      if (state.stopAt != null && state.rate > 0 && time >= state.stopAt) return { ...state, playhead: state.stopAt, playing: false, stopAt: null };
      return { ...state, playhead: time, playing: state.playing && !atEdge };
    }
  }
}

/** 選取的片段不存在了（被刪、被復原掉）就取消選取 */
function withValidSelection(state: AppState): AppState {
  const project = state.history.present;
  if (state.selectedClipId && !project.clips.some((c) => c.id === state.selectedClipId)) return { ...state, selectedClipId: null };
  if (state.selectedEffectId && !project.effects.some((e) => e.id === state.selectedEffectId)) return { ...state, selectedEffectId: null };
  return state;
}

/** V1 的軌道 id */
export function v1Id(project: Project): string | undefined {
  return project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index)[0]?.id;
}

/** 時間軸上所有剪輯點（V1 片段的起點與終點），排序去重 */
function editPoints(project: Project): Seconds[] {
  const v1 = v1Id(project);
  const points = project.clips.filter((c) => c.trackId === v1).flatMap((c) => [c.start, clipEnd(c)]);
  return [...new Set(points)].sort((a, b) => a - b);
}

/**
 * 吸附（§5.1）：t 和播放頭、各片段邊界的距離在 threshold 秒內就吸過去（取最近的）。
 * excludeClipId：正在拖的片段，不吸到它自己的邊界。
 */
export function snapTime(t: Seconds, state: AppState, threshold: Seconds, excludeClipId?: string): Seconds {
  const points = [state.playhead];
  for (const c of state.history.present.clips) {
    if (c.id !== excludeClipId) points.push(c.start, clipEnd(c));
  }
  let best = t;
  let bestDistance = threshold;
  for (const p of points) {
    const d = Math.abs(p - t);
    if (d <= bestDistance) {
      bestDistance = d;
      best = p;
    }
  }
  return best;
}

/** 熱鍵事件需要的欄位（方便測試，不綁 DOM 的 KeyboardEvent） */
export interface KeyInput {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
}

/** DaVinci Resolve 風格熱鍵 → 介面動作；沒有對應回 null（§5.1） */
export function keyToAction(e: KeyInput, state: AppState): Action | null {
  const project = state.history.present;
  const key = e.key.toLowerCase();
  if (e.ctrlKey && key === "z") return e.shiftKey ? { type: "redo" } : { type: "undo" };
  if (e.ctrlKey && key === "b") {
    // 切開播放頭下的 V1 片段
    const v1 = v1Id(project);
    const clip = project.clips.find((c) => c.trackId === v1 && c.start < state.playhead && clipEnd(c) > state.playhead);
    return clip ? { type: "commit", edits: [{ kind: "split", clipId: clip.id, t: state.playhead }] } : null;
  }
  if (e.ctrlKey) return null;
  // 播放：Space 切換；L 前進、J 倒退，同方向連按加速到 8 倍；K 停
  if (e.key === " ") return state.playing ? { type: "pause" } : { type: "play", rate: 1 };
  if (key === "k") return { type: "pause" };
  if (key === "l") return { type: "play", rate: state.playing && state.rate > 0 ? Math.min(8, state.rate * 2) : 1 };
  if (key === "j") return { type: "play", rate: state.playing && state.rate < 0 ? Math.max(-8, state.rate * 2) : -1 };
  // 範圍：I 設入點、O 設出點（另一端沿用目前範圍，沒有就從播放頭開始）；Esc 取消
  if (key === "i") return state.range && state.range.end > state.playhead ? { type: "setRange", start: state.playhead, end: state.range.end } : { type: "markIn", time: state.playhead };
  if (key === "o") return { type: "setRange", start: state.range?.start ?? state.markIn ?? state.playhead, end: state.playhead };
  switch (e.key) {
    case "Escape":
      return state.range || state.markIn != null ? { type: "clearRange" } : null;
    case "Delete":
    case "Backspace":
      // 有範圍時刪掉範圍（照字導字演），否則刪選取的片段或特效
      if (state.range) return { type: "deleteRange" };
      return state.selectedClipId || state.selectedEffectId ? { type: "deleteSelected" } : null;
    case "ArrowRight":
      return { type: "seek", time: state.playhead + 1 / FPS };
    case "ArrowLeft":
      return { type: "seek", time: state.playhead - 1 / FPS };
    case "ArrowDown": {
      const next = editPoints(project).find((p) => p > state.playhead + 1e-6);
      return next === undefined ? null : { type: "seek", time: next };
    }
    case "ArrowUp": {
      const prev = editPoints(project).filter((p) => p < state.playhead - 1e-6).pop();
      return prev === undefined ? null : { type: "seek", time: prev };
    }
  }
  return null;
}
