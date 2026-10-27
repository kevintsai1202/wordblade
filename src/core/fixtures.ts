import type { Clip, Project, Track } from "./model";

// 測試共用的專案：兩支影片＋一支配樂，V1×3、A1×3（和 V1 同素材同時間）、一個 V2 疊加、一條 A2 配樂、
// 一個跨在 9～11 秒上的特效、兩個時間軸定位點、m1 的幾個詞。

/** 建一個片段，沒給的欄位用預設值 */
export function makeClip(partial: Partial<Clip> & Pick<Clip, "id" | "mediaId" | "trackId" | "srcIn" | "srcOut" | "start">): Clip {
  return { speed: 1, opacity: 1, fadeIn: 0, fadeOut: 0, volume: 1, ...partial };
}

/** 建一條軌道 */
function makeTrack(id: string, kind: Track["kind"], index: number, extra: Partial<Track> = {}): Track {
  return { id, kind, index, muted: false, locked: false, volume: 1, ...extra };
}

/** 測試用專案 */
export function makeProject(): Project {
  return {
    media: [
      { id: "m1", kind: "video", duration: 600, fps: 30, audio: true },
      { id: "m2", kind: "video", duration: 300, fps: 30, audio: true },
      { id: "mus", kind: "audio", duration: 200 },
    ],
    tracks: [
      makeTrack("V1", "video", 0),
      makeTrack("V2", "video", 1),
      makeTrack("A1", "audio", 0, { role: "dialogue" }),
      makeTrack("A2", "audio", 1, { role: "music" }),
    ],
    clips: [
      makeClip({ id: "v1a", mediaId: "m1", trackId: "V1", srcIn: 0, srcOut: 10, start: 0 }),
      makeClip({ id: "v1b", mediaId: "m1", trackId: "V1", srcIn: 20, srcOut: 30, start: 10 }),
      makeClip({ id: "v1c", mediaId: "m2", trackId: "V1", srcIn: 0, srcOut: 10, start: 20 }),
      makeClip({ id: "a1a", mediaId: "m1", trackId: "A1", srcIn: 0, srcOut: 10, start: 0 }),
      makeClip({ id: "a1b", mediaId: "m1", trackId: "A1", srcIn: 20, srcOut: 30, start: 10 }),
      makeClip({ id: "a1c", mediaId: "m2", trackId: "A1", srcIn: 0, srcOut: 10, start: 20 }),
      makeClip({ id: "v2", mediaId: "m2", trackId: "V2", srcIn: 50, srcOut: 55, start: 12 }),
      makeClip({ id: "a2", mediaId: "mus", trackId: "A2", srcIn: 0, srcOut: 30, start: 0 }),
    ],
    words: [
      { id: "w1", mediaId: "m1", text: "hello", start: 1.0, end: 1.5 },
      { id: "w2", mediaId: "m1", text: "um", start: 1.6, end: 2.0 },
      { id: "w3", mediaId: "m1", text: "world", start: 2.5, end: 3.0 },
      { id: "w4", mediaId: "m1", text: "again", start: 21.0, end: 22.0 },
    ],
    captionBreaks: [],
    masks: [],
    effects: [
      {
        id: "e1", kind: "anim3d", start: 8, end: 12, pluginId: "p1", params: {}, anchorIds: [],
        cameraKeys: [
          { t: 0, position: [0, 0, 5], target: [0, 0, 0], fov: 50 },
          { t: 4, position: [0, 0, 2], target: [0, 0, 0], fov: 50 },
        ],
      },
    ],
    anchors: [
      { id: "an1", time: 15, x: 0.5, y: 0.5, label: "button", from: "user" },
      { id: "an2", time: 9.5, x: 0.2, y: 0.2, label: "cursor", from: "user" },
    ],
    suggestions: [],
    plugins: [],
    synths: [],
    stems: [],
  };
}
