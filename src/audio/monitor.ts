// 預覽的監聽靜音（2026-11-02）：卡拉 OK 錄音時可以關掉原聲（對白與先前的重配音），免得被麥克風收進去。
// 只影響預覽播放，不寫進專案、不影響匯出。PreviewPlayer 每一格都讀這裡。
import type { Track } from "../core/model";

/** 目前要靜音的音軌角色 */
let muted = new Set<NonNullable<Track["role"]>>();

/** 設定要靜音的音軌角色（空陣列＝全部照常） */
export function setMonitorMute(roles: NonNullable<Track["role"]>[]) {
  muted = new Set(roles);
}

/** 這個角色的音軌現在要不要靜音 */
export function isMonitorMuted(role: Track["role"]): boolean {
  return !!role && muted.has(role);
}
