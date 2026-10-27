// 桌面版自我檢查的本機回報伺服器（埠 8788）：GET /config 給要檢查的檔案清單，POST /report 收結果寫到 logs/desktop-selftest.json。
// 用法：node scripts/desktop-selftest/report-server.mjs <檔案1> <檔案2> …（由 run.ps1 啟動）
import { createServer } from "node:http";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** 結果檔位置 */
const RESULT = join(import.meta.dirname, "..", "..", "logs", "desktop-selftest.json");
/** 每個請求記一行，查「頁面有沒有連回來」用 */
const ACCESS_LOG = join(import.meta.dirname, "..", "..", "logs", "desktop-selftest-server.log");
/** 要檢查的檔案（命令列參數） */
const paths = process.argv.slice(2);

const server = createServer((req, res) => {
  appendFileSync(ACCESS_LOG, `${new Date().toISOString()} ${req.method} ${req.url} origin=${req.headers.origin ?? "-"}\n`);
  // 頁面在 http://tauri.localhost，跨來源呼叫要放行
  res.setHeader("Access-Control-Allow-Origin", req.headers.origin ?? "*");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") return res.end();
  if (req.url === "/config") {
    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ paths }));
  }
  let body = "";
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    if (req.url === "/report") {
      writeFileSync(RESULT, JSON.stringify(JSON.parse(body), null, 2));
      console.log("report received");
    }
    res.end("{}");
  });
});

server.listen(8788, "127.0.0.1", () => console.log("selftest report server on http://127.0.0.1:8788"));
