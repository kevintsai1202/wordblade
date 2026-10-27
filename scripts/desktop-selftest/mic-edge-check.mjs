// 麥克風對照組：用系統的 Edge（真實裝置，不用假麥克風）並預先授權麥克風，呼叫 getUserMedia。
// 用途：WordBlade 桌面版回 NotReadableError 時，判斷是 app 的問題，還是這台電腦（防毒、驅動）在裝置層擋住錄音。
// 用法：node scripts/desktop-selftest/mic-edge-check.mjs
import { chromium } from "@playwright/test";

const browser = await chromium.launch({ channel: "msedge" });
try {
  const context = await browser.newContext({ permissions: ["microphone"] });
  const page = await context.newPage();
  // 需要安全來源（https 或 localhost）才有 mediaDevices：用 data 頁不行，開一個 localhost 的空白頁
  await page.route("http://localhost/", (route) => route.fulfill({ body: "<html></html>", contentType: "text/html" }));
  await page.goto("http://localhost/");
  const result = await page.evaluate(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const label = stream.getAudioTracks()[0]?.label ?? "";
      stream.getTracks().forEach((t) => t.stop());
      return `ok (${label})`;
    } catch (e) {
      return e instanceof DOMException ? `${e.name}: ${e.message}` : String(e);
    }
  });
  console.log(`Edge getUserMedia：${result}`);
} finally {
  await browser.close();
}
