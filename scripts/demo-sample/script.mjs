// 模擬 D30 範例短片的講稿與畫面動作（spec §5.22）：開發者錄一段約 2 分鐘的英文螢幕錄影——
// 建一個「摘要會議筆記」的命令列小工具，途中在 .env 露出（假的）API 金鑰、講錯重講一次、帶自然的語助詞。
// 每一句：text（Fish Audio 唸的文字）、fillers（這句裡的語助詞，正確答案用）、gap（這句之後停多久，秒）、
// actions（畫面動作，在這句唸的期間做完）：open 切換檔案／終端機、type 打字（依這句的長度平均打完）、
// erase 刪掉最後幾個字、out 這句唸完時終端機印出的行。retake：這句是講錯、要被剪掉的部分。

/** 假的 API 金鑰（看起來像真的，給 SAM 遮罩與 AI 導演抓；不是任何服務的有效金鑰） */
export const FAKE_KEY = "sk-proj-4fX9qL2mV7pZc8WbN3yHa1KdT6sJ0eUo5rGi";

/** 編輯器裡的檔案（側欄依這個順序列出） */
export const FILES = [".env", "index.js", "notes.md", "package.json"];

/** 一開始就有內容的檔案 */
export const INITIAL = {
  "notes.md": "# Weekly sync — Oct 27\n\n- Export is done, ASR next\n- Mia: fix the timeline drag bug\n- Leo: record the demo video\n- Ship the web build on Friday\n",
  "package.json": "{\n  \"name\": \"notes-cli\",\n  \"type\": \"module\"\n}\n",
};

/** index.js 的內容（分段打） */
const CODE_LOAD = "import 'dotenv/config';\nimport OpenAI from 'openai';\nimport { readFileSync } from 'node:fs';\n\nconst client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });\nconst notes = readFileSync(process.argv[2], 'utf8');\n\n";
const CODE_WRONG = "const res = await client.completions.create(";
const CODE_RIGHT = "const res = await client.chat.completions.create({\n  model: 'gpt-4o-mini',\n  messages: [\n    { role: 'system', content: 'Summarize these meeting notes as 3 bullets and action items.' },\n    { role: 'user', content: notes },\n  ],\n});\n";
const CODE_PRINT = "console.log(res.choices[0].message.content);\n";
const CODE_GUARD = "\nprocess.on('uncaughtException', (err) => {\n  console.error(`Could not summarize: ${err.message}`);\n  process.exit(1);\n});\n";

/** 講稿 */
export const LINES = [
  { text: "Hey everyone. In this short video, I'm going to build a tiny command line tool that summarizes your meeting notes with an AI model.", fillers: [], gap: 0.5, actions: [{ open: "terminal" }] },
  { text: "It takes, um, about two minutes, so let's jump right in.", fillers: ["um"], gap: 0.6, actions: [] },
  { text: "Here's the kind of notes I mean. Just a few bullet points from our weekly sync.", fillers: [], gap: 0.4, actions: [{ open: "notes.md" }] },
  { text: "Nothing fancy, um, just plain markdown that anyone on the team can write.", fillers: ["um"], gap: 1.0, actions: [] },
  { text: "First, I'll create a new folder and install two packages, the OpenAI client and dotenv.", fillers: [], gap: 0.4, actions: [{ open: "terminal" }, { type: { terminal: "mkdir notes-cli && cd notes-cli\nnpm install openai dotenv" } }] },
  { text: "Okay, that's done.", fillers: [], gap: 1.0, actions: [{ out: ["added 2 packages, and audited 3 packages in 2s", "found 0 vulnerabilities"] }] },
  { text: "Next, uh, I'll open the dot env file and paste my API key here.", fillers: ["uh"], gap: 0.5, actions: [{ open: ".env" }, { type: { ".env": `OPENAI_API_KEY=${FAKE_KEY}\n` } }] },
  { text: "You know, you should never hard-code a key in your source code.", fillers: ["you know"], gap: 0.4, actions: [] },
  { text: "And, um, please don't share it on screen like I just did.", fillers: ["um"], gap: 1.0, actions: [] },
  { text: "Now let's write the main script.", fillers: [], gap: 0.3, actions: [{ open: "index.js" }] },
  { text: "We load the key with dotenv, and read the notes file from the first argument.", fillers: [], gap: 0.4, actions: [{ type: { "index.js": CODE_LOAD } }] },
  { text: "Then we call the chat endpoint with, uh, with the wrong", fillers: ["uh"], gap: 0.6, retake: true, actions: [{ type: { "index.js": CODE_WRONG } }] },
  { text: "Sorry, let me say that again.", fillers: [], gap: 0.5, retake: true, actions: [{ erase: { "index.js": CODE_WRONG.length } }] },
  { text: "Then we call the chat completions endpoint with the model name and a short system prompt.", fillers: [], gap: 0.4, actions: [{ type: { "index.js": CODE_RIGHT } }] },
  { text: "Finally, we print the summary.", fillers: [], gap: 1.0, actions: [{ type: { "index.js": CODE_PRINT } }] },
  { text: "Let's, um, try it on a real meeting.", fillers: ["um"], gap: 0.5, actions: [{ open: "terminal" }, { type: { terminal: "node index.js notes.md" } }] },
  {
    text: "And there it is: three bullet points and a list of action items.", fillers: [], gap: 0.4,
    actions: [{ out: ["• Export is finished; speech-to-text is the next milestone.", "• The timeline drag bug still needs a fix.", "• The web build ships on Friday.", "", "Action items:", "  - Mia: fix the timeline drag bug", "  - Leo: record the demo video", "", "(done in 4.1s)"] }],
  },
  { text: "That took about, uh, four seconds, which is fast enough for me.", fillers: ["uh"], gap: 1.0, actions: [] },
  { text: "One more thing. If the file is missing, the script crashes with a pretty ugly stack trace.", fillers: [], gap: 0.4, actions: [{ type: { terminal: "node index.js missing.md" } }, { out: ["node:fs:573", "  return binding.open(", "         ^", "Error: ENOENT: no such file or directory, open 'missing.md'", "    at Object.openSync (node:fs:573:18)"] }] },
  { text: "So let's add a small error handler that prints a friendly message instead.", fillers: [], gap: 0.4, actions: [{ open: "index.js" }, { type: { "index.js": CODE_GUARD } }] },
  { text: "And now, when I run it again with the wrong file name, we get one clear line.", fillers: [], gap: 1.0, actions: [{ open: "terminal" }, { type: { terminal: "node index.js missing.md" } }, { out: ["Could not summarize: ENOENT: no such file or directory, open 'missing.md'"] }] },
  { text: "Let me quickly recap.", fillers: [], gap: 0.3, actions: [] },
  { text: "We installed two packages, stored the key in a dot env file, and called the chat completions endpoint with our notes.", fillers: [], gap: 0.8, actions: [] },
  { text: "In the next video, I'll add streaming, so the summary shows up word by word.", fillers: [], gap: 0.4, actions: [] },
  { text: "Thanks for watching, and, you know, see you next time.", fillers: ["you know"], gap: 1.5, actions: [] },
];
