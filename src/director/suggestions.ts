// AI 導演建議的時間軸範圍、採用時的編輯、前端檢查（spec §5.11，docs/plan-10-28-director.md）。
// 建議用素材時間記：剪、遮罩、放大直接吃素材時間；特效、運鏡要時間軸範圍（suggestionSpan）。
// 剪、改字、放大是同步的一筆編輯（adoptEdits）；遮罩、特效、運鏡要跑 AI，由介面在 AI 完成後一次送出。
import type { Edit } from "../core/history";
import type { Project, Seconds, Suggestion } from "../core/model";
import { clipEnd, sourceToTimeline } from "../core/timeline";

/** 建議最短幾秒 */
const MIN_LENGTH = 0.1;

/**
 * 建議 → 時間軸範圍：用到這支素材的影像片段裡（V1 優先、再依開始時間），第一個和建議重疊的片段，取重疊的部分換成時間軸時間。
 * 素材已不在時間軸上（被剪掉或移除）回 null（介面不能採用需要時間軸範圍的建議）。
 */
export function suggestionSpan(project: Project, s: Suggestion): { start: Seconds; end: Seconds } | null {
  const order = new Map(project.tracks.filter((t) => t.kind === "video").sort((a, b) => a.index - b.index).map((t, i) => [t.id, i]));
  const clips = project.clips
    .filter((c) => c.mediaId === s.mediaId && order.has(c.trackId) && !c.freeze)
    .sort((a, b) => order.get(a.trackId)! - order.get(b.trackId)! || a.start - b.start);
  for (const c of clips) {
    const a = Math.max(s.start, c.srcIn);
    const b = Math.min(s.end, c.srcOut);
    if (b - a < MIN_LENGTH) continue;
    const start = sourceToTimeline(c, a);
    const end = sourceToTimeline(c, b);
    if (start === null || end === null) continue;
    return { start, end: Math.min(end, clipEnd(c)) };
  }
  return null;
}

/** 採用後把這條建議標成已採用（和編輯同一筆，一次 Ctrl+Z 全部回來） */
const applied = (s: Suggestion): Edit => ({ kind: "setSuggestionStatus", id: s.id, status: "applied" });

/**
 * 剪、改字、放大的採用：回傳要送出的編輯（含狀態）；不能採用（改字的詞已不存在）或要跑 AI 的種類回 null。
 */
export function adoptEdits(project: Project, s: Suggestion): Edit[] | null {
  const p = s.payload;
  switch (s.kind) {
    case "cut":
      return [{ kind: "cutRanges", ranges: [{ mediaId: s.mediaId, start: s.start, end: s.end }] }, applied(s)];
    case "zoom": {
      const w = Math.min(1, Math.max(0.25, Number(p.w) || 0.5));
      const cx = Math.min(1, Math.max(0, Number(p.cx) || 0.5));
      const cy = Math.min(1, Math.max(0, Number(p.cy) || 0.5));
      return [{ kind: "addZoom", zoom: { id: `zoom-${s.id}`, mediaId: s.mediaId, start: s.start, end: s.end, w, path: [{ src: s.start, cx, cy }], enabled: true } }, applied(s)];
    }
    case "fix": {
      const ids = Array.isArray(p.wordIds) ? (p.wordIds as unknown[]).map(String) : [];
      const text = typeof p.text === "string" ? p.text.trim() : "";
      const have = new Set(project.words.map((w) => w.id));
      if (!ids.length || !text || !ids.every((id) => have.has(id))) return null;
      return [{ kind: "editWords", wordIds: ids, text }, applied(s)];
    }
    default:
      return null;
  }
}

/** 一條建議的欄位對不對（各種類必填的欄位） */
function validPayload(s: Suggestion, scenes: Set<string>, wordIds: Set<string>): boolean {
  const p = s.payload ?? {};
  const str = (v: unknown) => typeof v === "string" && v.trim().length > 0;
  const unit = (v: unknown) => typeof v === "number" && v >= 0 && v <= 1;
  switch (s.kind) {
    case "cut": return true;
    case "mask": return str(p.target);
    case "effect": return str(p.description);
    case "camera": return str(p.description) && typeof p.scene === "string" && scenes.has(p.scene);
    case "fix": return str(p.text) && Array.isArray(p.wordIds) && p.wordIds.length > 0 && (p.wordIds as unknown[]).every((id) => wordIds.has(String(id)));
    case "zoom": return unit(p.cx) && unit(p.cy) && unit(p.w);
    default: return false;
  }
}

/** 前端再檢查一次閘道回的建議：時間夾在片長內、太短或欄位不對的丟掉、依時間排序（主要規則在閘道） */
export function clampSuggestions(list: Suggestion[], opts: { duration: Seconds; scenes: Set<string>; wordIds: Set<string> }): Suggestion[] {
  return list
    .map((s) => ({ ...s, start: Math.max(0, s.start), end: Math.min(opts.duration, s.end) }))
    .filter((s) => s.end - s.start >= MIN_LENGTH && validPayload(s, opts.scenes, opts.wordIds))
    .sort((a, b) => a.start - b.start);
}
