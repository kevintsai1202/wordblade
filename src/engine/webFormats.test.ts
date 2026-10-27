import { describe, expect, it } from "vitest";
import { classifyFile, webSupport } from "./webFormats";

describe("classifyFile（依副檔名與 MIME 分類）", () => {
  it("影片、圖片、聲音", () => {
    expect(classifyFile("a.MP4", "")).toBe("video");
    expect(classifyFile("b.mov", "video/quicktime")).toBe("video");
    expect(classifyFile("c.png", "")).toBe("image");
    expect(classifyFile("d.webp", "")).toBe("image");
    expect(classifyFile("e.mp3", "")).toBe("audio");
    expect(classifyFile("f.m4a", "")).toBe("audio");
    expect(classifyFile("g.wav", "audio/wav")).toBe("audio");
    expect(classifyFile("h.txt", "text/plain")).toBeNull();
  });
});

describe("webSupport（網頁版只吃瀏覽器解得了的格式，§5.21）", () => {
  it("H.264＋AAC 的 MP4、MOV 可以", () => {
    expect(webSupport({ kind: "video", container: "mp4", videoCodec: "avc", audioCodec: "aac" })).toBeNull();
    expect(webSupport({ kind: "video", container: "mov", videoCodec: "avc", audioCodec: null })).toBeNull();
  });

  it("其他影片格式提示改用 Windows 版", () => {
    expect(webSupport({ kind: "video", container: "mp4", videoCodec: "hevc", audioCodec: "aac" })).toMatch(/Windows app/);
    expect(webSupport({ kind: "video", container: "mkv", videoCodec: "avc", audioCodec: "aac" })).toMatch(/Windows app/);
    expect(webSupport({ kind: "video", container: "mp4", videoCodec: "avc", audioCodec: "ac3" })).toMatch(/Windows app/);
  });

  it("聲音：WAV、MP3、M4A（AAC）可以；圖片一律可以", () => {
    expect(webSupport({ kind: "audio", container: "wave", videoCodec: null, audioCodec: "pcm-s16" })).toBeNull();
    expect(webSupport({ kind: "audio", container: "mp3", videoCodec: null, audioCodec: "mp3" })).toBeNull();
    expect(webSupport({ kind: "audio", container: "mp4", videoCodec: null, audioCodec: "aac" })).toBeNull();
    expect(webSupport({ kind: "audio", container: "ogg", videoCodec: null, audioCodec: "vorbis" })).toMatch(/Windows app/);
    expect(webSupport({ kind: "image", container: null, videoCodec: null, audioCodec: null })).toBeNull();
  });
});
