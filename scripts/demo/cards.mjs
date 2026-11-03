// Demo 影片用的字卡與角標（docs/demo-script.md）：HTML 用 Playwright 截成 1920×1080 PNG，放進 WordBlade 的疊加軌（V2）或主軌。
// 角標與字卡是透明背景（只畫左上角的標籤或下方字卡）；片尾卡是不透明的整張。片頭（Flip intro）的封面從錄影抽格。
// 執行（PowerShell，repo 根目錄）：node scripts/demo/cards.mjs
// 產出：output/demo-cut/cards/*.png、output/demo-cut/covers/cover-*.png
import { chromium } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const OUT = join("output", "demo-cut");
const CARDS = join(OUT, "cards");
const COVERS = join(OUT, "covers");
mkdirSync(CARDS, { recursive: true });
mkdirSync(COVERS, { recursive: true });

/** 左上角的功能標籤：name＝檔名，title＝主標，sub＝用了哪個 Meta 模型 */
const LABELS = [
  { name: "label-asr", title: "Edit by words", sub: "Muse Voice Transcribe" },
  { name: "label-director", title: "AI director", sub: "Muse Wonder + Muse Spark 1.3" },
  { name: "label-sam", title: "Type what to hide", sub: "SAM 3.1" },
  { name: "label-vibe", title: "Vibe effects · 2D & 3D", sub: "Muse Wonder writes the plugin" },
  { name: "label-scene", title: "3D scenes & mascot", sub: "three.js, built into WordBlade" },
  { name: "label-publish", title: "Sound · publish kit · export", sub: "Muse Spark 1.3" },
  { name: "label-compositor", title: "Preview = export", sub: "one WebGL compositor" },
];

const BASE = `
  * { margin: 0; box-sizing: border-box; }
  html, body { width: 1920px; height: 1080px; background: transparent; font-family: "Segoe UI", Inter, Arial, sans-serif; overflow: hidden; }
`;

/** 左上角標籤：小型半透明膠囊（不擋內容）、青綠色重點 */
const label = (title, sub) => `<style>${BASE}
  .pill { position: absolute; left: 22px; top: 18px; padding: 8px 16px 8px 13px; border-radius: 12px; background: rgba(10,14,20,.72);
    border: 1.5px solid #2fe0c0; color: #fff; display: flex; gap: 10px; align-items: center; }
  .dot { width: 10px; height: 10px; border-radius: 50%; background: #2fe0c0; box-shadow: 0 0 10px #2fe0c0; }
  .t { font-size: 24px; font-weight: 800; }
  .s { font-size: 16px; color: #9ff6e8; font-weight: 600; }
</style><div class="pill"><div class="dot"></div><div><div class="t">${title}</div><div class="s">${sub}</div></div></div>`;

/** 下方字卡（開場「這支影片是 WordBlade 剪的」） */
const lowerThird = (text) => `<style>${BASE}
  .bar { position: absolute; left: 50%; top: 60px; transform: translateX(-50%); padding: 26px 54px; border-radius: 22px;
    background: linear-gradient(90deg, #0b0f15ee, #102a2aee); border: 3px solid #2fe0c0; color: #fff; font-size: 64px; font-weight: 900;
    box-shadow: 0 16px 60px rgba(0,0,0,.55); white-space: nowrap; }
  b { color: #2fe0c0; }
</style><div class="bar">${text}</div>`;

/** 片尾卡：整張不透明 */
const endCard = `<style>${BASE}
  body { background: radial-gradient(circle at 30% 30%, #12343a 0%, #0a0d12 60%); color: #fff; }
  .wrap { position: absolute; left: 140px; top: 200px; }
  h1 { font-size: 150px; font-weight: 900; letter-spacing: -2px; }
  h1 span { color: #2fe0c0; }
  .tag { font-size: 48px; color: #cfe; margin-top: 10px; font-weight: 600; }
  .links { margin-top: 70px; font-size: 44px; line-height: 1.7; font-weight: 700; }
  .links div::before { content: "▸ "; color: #2fe0c0; }
  .models { position: absolute; left: 140px; bottom: 90px; font-size: 30px; color: #9bb; font-weight: 600; }
</style><div class="wrap"><h1>Word<span>Blade</span></h1><div class="tag">Edit video by editing words. Effects written by AI.</div>
<div class="links"><div>wordblade.zeabur.app — try it in your browser</div><div>github.com/kevintsai1202/wordblade</div></div></div>
<div class="models">Built with Muse Voice Transcribe · Muse Spark 1.3 · Muse Wonder · Muse Image · SAM 3.1</div>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
/** 一張 HTML 截成 PNG（omit＝透明背景） */
const shot = async (html, file, transparent = true) => {
  await page.setContent(`<!doctype html><meta charset="utf-8"><body>${html}</body>`);
  await page.screenshot({ path: file, omitBackground: transparent });
};
for (const l of LABELS) await shot(label(l.title, l.sub), join(CARDS, `${l.name}.png`));
await shot(lowerThird("This video was edited by <b>WordBlade</b>"), join(CARDS, "edited.png"));
await shot(endCard, join(CARDS, "end.png"), false);
// 快轉角標（右下角）：剪片時用 WordBlade 的片段變速快轉的地方
await shot(`<style>${BASE}
  .sp { position: absolute; right: 28px; bottom: 120px; padding: 8px 16px; border-radius: 12px; background: rgba(10,14,20,.86); border: 2px solid #ffb020;
    color: #fff; font-size: 22px; font-weight: 800; } .sp b { color: #ffb020; } .sp small { font-size: 15px; color: #fde3b0; font-weight: 600; margin-left: 10px; }
</style><div class="sp"><b>⏩ Fast-forward</b><small>WordBlade speed ramp</small></div>`, join(CARDS, "speed.png"));
await browser.close();

// 片頭封面：各功能成品的特寫（翻頁時一眼看得懂），[來源, 秒, 裁切 x, y, 寬, 高]（1920×1080 像素）
const COVER_FRAMES = [
  ["output/demo-3d/two-stage.mp4", 8, 760, 380, 1100, 620],
  ["output/sample-effects-export.mp4", 28, 0, 0, 1920, 1080],
  ["output/sample-effects-export.mp4", 55, 560, 180, 800, 450],
  ["output/demo-rec/S3-mask.mp4", 46, 160, 40, 1040, 585],
  ["output/sample-effects-export.mp4", 71, 0, 100, 1280, 720],
  ["output/demo-3d/two-stage.mp4", 2, 300, 280, 1200, 675],
  ["output/sample-effects-export.mp4", 99, 400, 200, 1100, 620],
  ["output/demo-rec/S4-vibe.mp4", 76, 280, 120, 900, 506],
];
COVER_FRAMES.forEach(([src, t, x, y, w, h], i) => {
  execFileSync("ffmpeg", ["-v", "error", "-y", "-ss", String(t), "-i", src, "-frames:v", "1", "-vf", `crop=${w}:${h}:${x}:${y},scale=1280:720`, join(COVERS, `cover-${i + 1}.png`)]);
});
console.log(`已存 ${CARDS}（${LABELS.length + 3} 張）、${COVERS}（${COVER_FRAMES.length} 張）`);
