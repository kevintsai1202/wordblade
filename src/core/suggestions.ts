// AI 導演的建議（spec §5.11）：存在專案裡（素材時間）；重跑導演時換掉同一支素材的建議；採用或略過改狀態。
import type { Project, Suggestion } from "./model";

/** 換掉一支素材的全部建議（其他素材的留著） */
export function setSuggestions(project: Project, mediaId: string, suggestions: Suggestion[]): Project {
  return { ...project, suggestions: [...(project.suggestions ?? []).filter((s) => s.mediaId !== mediaId), ...suggestions] };
}

/** 改一條建議的狀態 */
export function setSuggestionStatus(project: Project, id: string, status: Suggestion["status"]): Project {
  return { ...project, suggestions: (project.suggestions ?? []).map((s) => (s.id === id ? { ...s, status } : s)) };
}
