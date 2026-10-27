// 產生閘道用的 Vibe特效系統提示詞（gateway/src/main/resources/vibe/system-prompt.txt；3D 是 system-prompt-3d.txt）。
// 插件 API（src/anim/anim_api_manifest.json）、元件庫或直譯器的禁用清單改了就重跑：node scripts/vibe/build-prompt.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { systemPrompt } from "./prompt.mjs";
import { systemPrompt3d } from "./prompt3d.mjs";

const out = join(import.meta.dirname, "..", "..", "gateway", "src", "main", "resources", "vibe", "system-prompt.txt");
const text = systemPrompt();
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, text, "utf8");
console.log(`wrote ${out} (${text.length} chars)`);

// 3D（three.js 插件）
const out3d = join(dirname(out), "system-prompt-3d.txt");
const text3d = systemPrompt3d();
writeFileSync(out3d, text3d, "utf8");
console.log(`wrote ${out3d} (${text3d.length} chars)`);
