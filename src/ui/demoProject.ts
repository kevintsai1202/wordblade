// 骨架階段的示範專案：兩支錄課影片、一個子母畫面、幾句英文逐字稿（A2 配樂軌留空：repo 裡沒有配樂素材）。
// 素材庫與匯入做好後就由真正的專案取代。
import type { Clip, Project, Word } from "../core/model";

/** 示範用的英文逐字稿：每句拆成詞，依序排在素材時間上 */
const SENTENCES = [
  "Okay, next let's talk about why we're installing all of this stuff.",
  "First up is our basic environment.",
  "I have to update my PowerShell to version 7 or above.",
  "In Windows there's a CLI tool, which is my terminal interface.",
  "So the commands in 7 are pretty different from 5.",
  "Next, Java 21 and Maven are the basic tools for development.",
  "Git is for version control, and that's the basic environment check.",
  "When we build a system with a frontend and a backend, we set up the backend first.",
];

/** 把句子攤成詞：每個詞約 0.32 秒、句與句之間停 0.8 秒 */
function demoWords(mediaId: string, offset: number): Word[] {
  const words: Word[] = [];
  let t = offset;
  SENTENCES.forEach((sentence, s) => {
    sentence.split(" ").forEach((text, i) => {
      words.push({ id: `${mediaId}-w${s}-${i}`, mediaId, text, start: round(t), end: round(t + 0.28) });
      t += 0.32;
    });
    t += 0.8;
  });
  return words;
}

/** 量化到毫秒 */
function round(t: number): number {
  return Math.round(t * 1000) / 1000;
}

/** 建一個片段 */
function clip(id: string, mediaId: string, trackId: string, srcIn: number, srcOut: number, start: number): Clip {
  return { id, mediaId, trackId, srcIn, srcOut, start, speed: 1, opacity: 1, fadeIn: 0, fadeOut: 0, volume: 1 };
}

/**
 * 示範專案。root：素材資料夾（Engine.demoMediaRoot：網頁版是 "samples"、Windows 版是 repo 裡 samples/ 的絕對路徑）
 */
export function demoProject(root = "samples"): Project {
  return {
    media: [
      { id: "lecture-a", name: "lecture-a.en.mp4", path: `${root}/lecture-a.en.mp4`, kind: "video", duration: 282.1, fps: 30, width: 1920, height: 1080, audio: true },
      { id: "lecture-b", name: "lecture-b.en.mp4", path: `${root}/lecture-b.en.mp4`, kind: "video", duration: 396.6, fps: 30, width: 1920, height: 1080, audio: true },
    ],
    tracks: [
      { id: "V1", kind: "video", index: 0, muted: false, locked: false, volume: 1 },
      { id: "V2", kind: "video", index: 1, muted: false, locked: false, volume: 1 },
      { id: "A1", kind: "audio", index: 0, role: "dialogue", muted: false, locked: false, volume: 1 },
      { id: "A2", kind: "audio", index: 1, role: "music", muted: false, locked: false, volume: 0.4 },
    ],
    clips: [
      clip("v1-a", "lecture-a", "V1", 0, 60, 0),
      clip("v1-b", "lecture-b", "V1", 30, 90, 60),
      clip("a1-a", "lecture-a", "A1", 0, 60, 0),
      clip("a1-b", "lecture-b", "A1", 30, 90, 60),
      { ...clip("v2-pip", "lecture-b", "V2", 120, 135, 20), transform: { x: 0.72, y: 0.04, w: 0.25, h: 0.25 } },
    ],
    words: [...demoWords("lecture-a", 0.5), ...demoWords("lecture-b", 31)],
    captionBreaks: [],
    masks: [],
    effects: [{ id: "fx-1", kind: "anim2d", start: 8, end: 12, pluginId: "arrow", params: {}, anchorIds: [] }],
    anchors: [],
    suggestions: [],
    plugins: [],
    synths: [],
    stems: [],
  };
}
