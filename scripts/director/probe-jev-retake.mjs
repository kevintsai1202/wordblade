// 探測 Jev（TypeSafe System One）判斷「重講」準不準（docs/plan-10-31-director4.md）：
// 每一對候選（剪掉的那段 cut、後面的那段 restart）問兩題 Noul：是不是同一件事重講、restart 是不是完整的一次；
// 題目含中文真人錄影（E:\OBS 2026-09-13 09-46-10）的正例、換句話說的英文正例、相似但不是重講的反例。
// 金鑰從 repo 的 .env 讀（TYPESAFE_API_KEY，不印出）。用法（repo 根目錄）：node scripts/director/probe-jev-retake.mjs
import { readFileSync } from "node:fs";

const env = Object.fromEntries(readFileSync(".env", "utf8").split(/\r?\n/).map((l) => /^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));

/** 題目：cut、restart 與正確答案（重講？restart 完整？） */
const CASES = [
  { name: "中文：19 秒講一半→23 秒重講", cut: "好，我們接下來這個章節", restart: "我們接下來這個章節主要介紹 Spring MVC。", retake: true },
  { name: "中文：23～60 秒第一次開場→66 秒重錄", cut: "我們接下來這個章節主要介紹 Spring MVC。好，那 Spring MVC 在 Spring 這一套框架裡面，它是算是一個很核心的一個功能。好，那以前為什麼會叫 MVC？我們後面會來跟大家講一下。好，那其實……我們要", restart: "好，我們接下來這個章節會介紹 Spring 一個很很核心的套件，叫做 Spring MVC。它其實在以前它其實是", retake: true },
  { name: "英文：換句話說的重講", cut: "So now let's open the config file and, uh, wait, sorry.", restart: "Okay, let's take a look at the settings in config.yaml.", retake: true },
  { name: "英文：說錯重來", cut: "Then we call the chat endpoint with the wrong sorry let me say that again.", restart: "Then we call the chat completions endpoint with the model name and a short system prompt.", retake: true },
  { name: "中文反例：同主題、往下講", cut: "我們先來看資料夾的結構，這裡有 src 跟 test 兩個資料夾。", restart: "接著打開 src 裡面的主程式，看看它做了什麼。", retake: false },
  { name: "英文反例：重複用字但是新步驟", cut: "First I'll create a new folder and install two packages.", restart: "Now I'll create the main script file inside that folder.", retake: false },
  { name: "中文反例：總結前面講過的", cut: "這個章節我們介紹了 Controller、Service 跟 Repository 三層。", restart: "最後幫大家整理一下，剛剛講的 Controller、Service、Repository 各自負責什麼。", retake: false },
];

/** 問 Jev：兩題 Noul */
async function ask(c) {
  const t0 = Date.now();
  const res = await fetch("https://api.typesafe.ai/v1/systemone", {
    method: "POST",
    headers: { authorization: `Bearer ${env.TYPESAFE_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: "jev-latest",
      state: { context: "Transcript of a screen-recorded tutorial. `earlier` is said first, `later` is said right after it.", earlier: c.cut, later: c.restart },
      questions: {
        retake: {
          type: "noul",
          instructions: "The speaker abandons or fumbles `earlier` and says the same content again in `later`, so an editor should cut `earlier` and keep `later`.",
          criteria: {
            true: "`later` is a new attempt at what `earlier` was saying (same point, possibly reworded, possibly more complete).",
            false: "`later` moves on to the next point, adds new information, or summarises; `earlier` is needed for the content.",
          },
        },
        complete: { type: "noul", instructions: "`later` delivers the point completely; the speaker does not abandon it halfway." },
      },
    }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, ms: Date.now() - t0, retake: body.answers?.retake?.noul, complete: body.answers?.complete?.noul, tokens: body.usage?.input_tokens, model: body.model, error: res.ok ? null : JSON.stringify(body).slice(0, 200) };
}

let right = 0;
for (const c of CASES) {
  const a = await ask(c);
  if (a.error) { console.log(`${c.name}: HTTP ${a.status} ${a.error}`); continue; }
  const ok = (a.retake >= 0.5) === c.retake;
  if (ok) right++;
  console.log(`${ok ? "✓" : "✗"} ${c.name}: retake ${a.retake.toFixed(2)}（應為 ${c.retake}）、complete ${a.complete.toFixed(2)}；${a.ms} ms、${a.tokens} tokens、${a.model}`);
}
console.log(`正確 ${right}/${CASES.length}`);
