// 匯出時一併輸出的 SRT（spec §5.4）：字幕是剪後的時間軸時間（buildCaptions 已換算好）。
import type { Caption } from "../core/captions";
import type { Seconds } from "../core/model";

/** 秒 → SRT 時間（HH:MM:SS,mmm） */
export function srtTime(t: Seconds): string {
  const ms = Math.round(Math.max(0, t) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

/** 字幕 → SRT 文字（CRLF，播放器相容性最好） */
export function toSrt(captions: Caption[]): string {
  return captions
    .map((c, i) => [String(i + 1), `${srtTime(c.start)} --> ${srtTime(c.end)}`, ...c.lines].join("\r\n") + "\r\n")
    .join("\r\n");
}
