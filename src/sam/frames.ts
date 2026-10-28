// 取素材某幾個時間的畫面成 JPEG（螢幕文字定位用，§5.3）：mediabunny＋WebCodecs，桌面與網頁共用；
// 用原檔（Engine.exportSource）不用代理檔：540p 放大後小字讀不清楚。
/** 取 times（素材時間）的畫面，縮到寬 width，JPEG 品質 0.85 */
export async function grabJpegs(source: Blob | string, times: number[], width = 1280): Promise<Uint8Array[]> {
  const mb = await import("mediabunny");
  const input = new mb.Input({ source: typeof source === "string" ? new mb.UrlSource(source) : new mb.BlobSource(source), formats: mb.ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track) throw new Error("No video track");
    const sink = new mb.CanvasSink(track, { width: Math.min(width, await track.getDisplayWidth()), poolSize: 2 });
    const out: Uint8Array[] = [];
    for await (const frame of sink.canvasesAtTimestamps(times)) {
      if (!frame) {
        out.push(new Uint8Array());
        continue;
      }
      const c = frame.canvas;
      const blob = c instanceof OffscreenCanvas
        ? await c.convertToBlob({ type: "image/jpeg", quality: 0.85 })
        : await new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error("toBlob failed"))), "image/jpeg", 0.85));
      out.push(new Uint8Array(await blob.arrayBuffer()));
    }
    return out;
  } finally {
    input.dispose();
  }
}
