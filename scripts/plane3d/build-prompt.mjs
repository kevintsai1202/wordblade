// 產生閘道「用說的」的資源檔：gateway/src/main/resources/plane3d/system-prompt.txt 與 ranges.json（範圍只有一份來源：原專案的姿勢數學）。
// 姿勢數學或背景選項改了就重跑：node scripts/plane3d/build-prompt.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ranges, systemPrompt } from "./prompt.mjs";

const dir = join(import.meta.dirname, "..", "..", "gateway", "src", "main", "resources", "plane3d");
mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, "system-prompt.txt"), systemPrompt(), "utf8");
writeFileSync(join(dir, "ranges.json"), JSON.stringify(ranges(), null, 2), "utf8");
console.log(`wrote ${dir}`);
