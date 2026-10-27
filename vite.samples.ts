// 開發與 e2e 用：把 repo 的 samples/ 以 /samples/* 提供給瀏覽器（支援 Range 請求，<video> 拖動要用）。
// 只在 vite dev 與 vite preview 生效，不會打包進正式網頁版（samples/ 也不進版控）。
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve } from "node:path";
import type { Connect, Plugin } from "vite";

/** samples 目錄的絕對路徑 */
const SAMPLES_DIR = resolve(__dirname, "samples");

/** 依副檔名回傳 Content-Type */
function contentType(path: string): string {
  if (path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".webm")) return "video/webm";
  if (path.endsWith(".wav")) return "audio/wav";
  if (path.endsWith(".srt")) return "text/plain; charset=utf-8";
  return "application/octet-stream";
}

/** /samples/* 的中介層：檔案不存在回 404，有 Range 就回 206 部分內容 */
const serveSamples: Connect.NextHandleFunction = (req, res, next) => {
  if (!req.url?.startsWith("/samples/")) return next();
  const rel = decodeURIComponent(req.url.slice("/samples/".length).split("?")[0]);
  const file = normalize(join(SAMPLES_DIR, rel));
  if (!file.startsWith(SAMPLES_DIR) || !existsSync(file)) {
    res.statusCode = 404;
    return res.end();
  }
  const size = statSync(file).size;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", contentType(file));
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? "");
  if (range) {
    const start = range[1] ? Number(range[1]) : 0;
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    res.statusCode = 206;
    res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
    res.setHeader("Content-Length", end - start + 1);
    createReadStream(file, { start, end }).pipe(res);
  } else {
    res.setHeader("Content-Length", size);
    createReadStream(file).pipe(res);
  }
};

/** Vite 外掛：dev 與 preview 伺服器都掛上 /samples/* */
export function samplesPlugin(): Plugin {
  return {
    name: "wordblade-samples",
    configureServer(server) { server.middlewares.use(serveSamples); },
    configurePreviewServer(server) { server.middlewares.use(serveSamples); },
  };
}
