// 沙盒實測用的伺服器：
//   1. 主頁伺服器（模擬合成器頁面），依 variant 回不同的「父頁 CSP」標頭。
//   2. 誘餌伺服器（另一個 port，等於「外部網站」）：記錄所有被打到的 HTTP／WebSocket／UDP(STUN) 請求，
//      用來證明被擋的連線「真的沒有送出去」，而不是只看瀏覽器端回報。
import http from 'node:http';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

/** 讀檔並把 CRLF 正規化成 LF（HTML 解析器會把 inline script 的 CRLF 轉 LF，雜湊必須用同一份文字）。 */
function readText(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
}

/** 計算文字的 CSP sha256 來源表達式。 */
function cspHash(text) {
  return `'sha256-${crypto.createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/**
 * 組出父頁 CSP。三種 variant 對應「srcdoc iframe 的啟動腳本怎麼過父頁 CSP」：
 *   nonce：父頁與 iframe 共用同一個 nonce（spec 現行寫法）
 *   hash ：父頁與 iframe 都用啟動腳本的 sha256（父頁 CSP 可以是靜態字串，Tauri 也寫得出來）
 *   blob ：iframe 啟動腳本以 blob: URL 載入（父頁得放行 script-src blob:）
 * @param {'nonce'|'hash'|'blob'} variant
 * @param {string} nonce 這次請求產生的 nonce
 * @param {boolean} pblob 父頁是否另外放行 script-src blob:
 * @param {boolean} pframe 父頁是否故意放寬 frame-src（對照組）
 */
function parentCsp(variant, nonce, pblob, pframe) {
  let scriptSrc = "'self'";
  if (variant === 'nonce') scriptSrc += ` 'nonce-${nonce}'`;
  if (variant === 'hash') scriptSrc += ` ${cspHash(readText('public/iframe-runtime.js'))}`;
  if (variant === 'blob' || pblob) scriptSrc += ' blob:'; // pblob：父頁放行 blob: script（iframe 主執行緒以 blob: 載入程式的退路才需要）
  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "connect-src 'self'",
    'worker-src blob:',
    pframe ? 'frame-src *' : "frame-src 'none'", // srcdoc 是否仍可載入、以及 iframe 導航外洩能不能擋，是這次要測的項目（pframe：故意放寬，當對照組）
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** 啟動主頁伺服器與誘餌伺服器，回傳 port 與誘餌的記錄器。 */
export async function startServers() {
  /** 誘餌伺服器收到的請求記錄。 */
  const hits = { http: [], ws: [], udp: 0 };
  const decoy = http.createServer((req, res) => {
    hits.http.push(req.url);
    res.writeHead(200, { 'access-control-allow-origin': '*', 'content-type': 'text/javascript' });
    res.end('/* decoy */');
  });
  decoy.on('upgrade', (req, socket) => { hits.ws.push(req.url); socket.destroy(); });
  const udp = dgram.createSocket('udp4');
  udp.on('message', () => { hits.udp++; });
  await new Promise((r) => decoy.listen(0, '127.0.0.1', r));
  await new Promise((r) => udp.bind(0, '127.0.0.1', r));

  const main = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const file = url.pathname === '/' ? '/main.html' : url.pathname;
    const rel = path.join(file.startsWith('/dist/') || file.startsWith('/plugins/') ? '' : 'public', file);
    const abs = path.join(ROOT, rel);
    if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) { res.writeHead(404); return res.end('404'); }
    const headers = { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store' };
    let body = readText(path.relative(ROOT, abs));
    if (file === '/main.html') {
      const variant = url.searchParams.get('variant') || 'nonce';
      const nonce = crypto.randomBytes(16).toString('base64');
      headers['content-security-policy'] = parentCsp(variant, nonce, url.searchParams.get('pblob') === '1', url.searchParams.get('pframe') === '1');
      body = body.replace('__NONCE__', nonce);
    }
    res.writeHead(200, headers);
    res.end(body);
  });
  await new Promise((r) => main.listen(0, '127.0.0.1', r));
  const mainPort = main.address().port;
  return {
    mainPort,
    decoyPort: decoy.address().port,
    udpPort: udp.address().port,
    hits,
    mainOrigin: `http://127.0.0.1:${mainPort}`,
    decoyOrigin: `http://127.0.0.1:${decoy.address().port}`,
    async close() { main.close(); decoy.close(); udp.close(); },
  };
}

// 直接執行（npm run serve）時只開伺服器，方便人工用瀏覽器看
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const s = await startServers();
  console.log(`主頁 ${s.mainOrigin}/main.html?variant=nonce　誘餌 ${s.decoyOrigin}　STUN(UDP) ${s.udpPort}`);
}
