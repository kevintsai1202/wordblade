// 10/27 實測⑤⑥的本機回聲伺服器：記錄 Tauri（WebView2）送出的 Origin，並接收頁面回報的麥克風等測試結果。
// 用法：node spikes/tauri-env/echo-server.mjs（埠 8787）；結果寫到 spikes/tauri-env/RESULT.json
import { createServer } from 'node:http';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 結果檔位置 */
const RESULT = join(dirname(fileURLToPath(import.meta.url)), 'RESULT.json');
/** 收到的紀錄：每個請求的方法、路徑、Origin，以及頁面回報的結果 */
const record = { requests: [], report: null };

const server = createServer((req, res) => {
  const origin = req.headers.origin ?? null;
  record.requests.push({ method: req.method, path: req.url, origin, at: new Date().toISOString() });
  // 一律放行，才能讓頁面讀到回應；我們要看的是它送了什麼 Origin
  res.setHeader('Access-Control-Allow-Origin', origin ?? '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type, authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.end();

  let body = '';
  req.on('data', chunk => { body += chunk; });
  req.on('end', () => {
    if (req.url === '/report') record.report = JSON.parse(body);
    writeFileSync(RESULT, JSON.stringify(record, null, 2));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ origin }));
    console.log(req.method, req.url, 'Origin:', origin);
  });
});

server.listen(8787, '127.0.0.1', () => console.log('echo server on http://127.0.0.1:8787'));
