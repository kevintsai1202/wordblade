// 印出 Playwright 啟動 chromium／msedge 時實際生效的命令列（chrome://version），
// 用來確認有沒有哪個 --disable-features 影響 Worker 或行程隔離。
import { chromium } from 'playwright-core';

for (const [id, opt] of [['chromium', { headless: false }], ['msedge', { channel: 'msedge', headless: false }]]) {
  const b = await chromium.launch(opt);
  const p = await b.newPage();
  await p.goto('chrome://version');
  const t = await p.locator('#command_line').innerText().catch(async () => (await p.innerText('body')));
  console.log(`=== ${id} ===\n${t.replace(/ --/g, '\n--')}\n`);
  await b.close();
}
