// 閘道的資源檔（schema 複本與提示詞）由 scripts/synth/build-prompt.mjs 從這裡的 schema 與範本產生；改了這裡忘記重跑就會在這裡抓到。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import schema from "./synth.schema.json";
import { MUSIC_EXAMPLES, SOUND_TEMPLATES } from "./templates";

/** 閘道資源檔的資料夾 */
const DIR = join(__dirname, "..", "..", "..", "gateway", "src", "main", "resources", "synth");
/** 讀閘道的資源檔 */
const read = (name: string) => readFileSync(join(DIR, name), "utf8");

describe("閘道資源檔與前端同步（node scripts/synth/build-prompt.mjs）", () => {
  it("schema 複本一樣", () => {
    expect(JSON.parse(read("synth.schema.json"))).toEqual(schema);
  });

  it("音效提示詞帶著每個內建範本當例子，配樂提示詞帶著每個範例", () => {
    const sound = read("system-prompt-sound.txt");
    for (const t of SOUND_TEMPLATES) expect(sound, t.id).toContain(JSON.stringify(t.spec));
    const music = read("system-prompt-music.txt");
    for (const t of MUSIC_EXAMPLES) expect(music, t.id).toContain(JSON.stringify(t.spec));
  });
});
