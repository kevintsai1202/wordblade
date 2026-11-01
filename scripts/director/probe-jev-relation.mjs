// 探測 Jev 判斷「句子講完整沒有」與「前後兩句的關係」準不準（docs/plan-10-31-director4.md）：
// ① 每一句一題 Noul：講完整了嗎；② 每一對兩題 Noul：重講（後面取代前面）、補充（後面補前面漏講的，兩段都留）。
// 2026-10-31 先試過三選一 Choice：中文重講判錯 2 題，改成兩題 Noul。
// 金鑰從 repo 的 .env 讀（TYPESAFE_API_KEY，不印出）。用法（repo 根目錄）：node scripts/director/probe-jev-relation.mjs
import { readFileSync } from "node:fs";

const env = Object.fromEntries(readFileSync(".env", "utf8").split(/\r?\n/).map((l) => /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));

/** 講完整的題目：句子與正確答案 */
const SENTENCES = [
  ["那其實", false],
  ["我們要", false],
  ["好，我們接下來這個章節", false],
  ["它其實在以前它其實是", false],
  ["好，那以前為什麼會叫 MVC？我們後面會來跟大家講一下。", true],
  ["這個章節會介紹 Spring 一個很核心的套件，叫做 Spring MVC。", true],
  ["So the next thing we need is the", false],
  ["Then we call the chat completions endpoint with the model name.", true],
];

/** 關係的題目 */
const PAIRS = [
  ["中文重講：講一半→重講", "好，我們接下來這個章節", "我們接下來這個章節主要介紹 Spring MVC。", "retake"],
  ["中文重講：斷掉→換說法重來", "那其實……我們要", "好，我們接下來這個章節會介紹 Spring 一個很核心的套件，叫做 Spring MVC。", "retake"],
  ["中文補充：剛剛忘了說", "這裡要先安裝 JDK 17，然後建立專案。", "喔對，剛剛忘了說，JDK 要用 Temurin 的版本，不然等一下會出錯。", "supplement"],
  ["中文補充：補上漏講的步驟", "接著執行 mvn package 打包。", "打包之前記得先把 application.yml 的資料庫密碼改掉。", "supplement"],
  ["英文補充", "Now run npm install to get the dependencies.", "Oh, and I forgot to mention, you need Node 20 or newer for this to work.", "supplement"],
  ["英文重講", "So the next thing we need is the", "Okay, the next thing we need is an API key from the dashboard.", "retake"],
  ["中文無關：往下講", "我們先來看資料夾的結構。", "接著打開主程式，看看它做了什麼。", "unrelated"],
  ["中文無關：總結", "這個章節我們介紹了 Controller、Service 跟 Repository 三層。", "下一個章節我們會開始寫測試。", "unrelated"],
];

/** 送一次 */
async function call(state, questions) {
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({ model: "jev-1.14.0", state, questions }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(body).slice(0, 200)}`);
  return body;
}

let right = 0;
let total = 0;
for (const [text, complete] of SENTENCES) {
  const b = await call({ context: "One sentence from the transcript of a spoken screen-recorded tutorial.", sentence: text }, {
    complete: { type: "noul", instructions: "`sentence` is a complete thought: the speaker finishes what they set out to say, rather than trailing off or stopping halfway." },
  });
  const p = b.answers.complete.noul;
  const ok = (p >= 0.5) === complete;
  right += ok ? 1 : 0;
  total++;
  console.log(`${ok ? "✓" : "✗"} 完整 ${p.toFixed(2)}（應為 ${complete}）${text}`);
}
for (const [name, earlier, later, want] of PAIRS) {
  // 改用兩題 Noul（三選一 Choice 在中文重講上判錯 2 題）：重講（沿用 RestJevRetakeJudge 的題目）、補充
  const b = await call({ context: "Transcript of a screen-recorded tutorial. `earlier` is said first, `later` is said shortly after.", earlier, later }, {
    retake: {
      type: "noul",
      instructions: "The speaker abandons or fumbles `earlier` and says the same content again in `later`, so an editor should cut `earlier` and keep `later`.",
      criteria: {
        true: "`later` is a new attempt at what `earlier` was saying (same point, possibly reworded, possibly more complete).",
        false: "`later` moves on to the next point, adds new information, or summarises; `earlier` is needed for the content.",
      },
    },
    falseStart: {
      type: "noul",
      instructions: "`earlier` is an abandoned false start: the speaker stops before saying anything the viewer needs, then starts over in `later`.",
    },
    supplement: {
      type: "noul",
      instructions: "In `later` the speaker adds something they forgot or left out about `earlier` (for example \"oh, I forgot to mention\"), so both parts are needed.",
    },
  });
  const r = b.answers.retake.noul;
  const sp = b.answers.supplement.noul;
  const fs = b.answers.falseStart.noul;
  // 判定：重講或放棄的碎片 ≥ 0.6 → retake；否則補充 ≥ 0.6 → supplement；否則 unrelated
  const got = r >= 0.6 || fs >= 0.6 ? "retake" : sp >= 0.6 ? "supplement" : "unrelated";
  const ok = got === want;
  right += ok ? 1 : 0;
  total++;
  console.log(`${ok ? "✓" : "✗"} ${name}：${got}（應為 ${want}）retake ${r.toFixed(2)}、falseStart ${fs.toFixed(2)}、supplement ${sp.toFixed(2)}`);
}
console.log(`正確 ${right}/${total}`);
