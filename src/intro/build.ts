// 組一支翻頁式片頭（spec §5.23）：計畫 → 佔位黑圖、音效、內建配樂（產生過的沿用）→ 要插入時間軸的 IntroInsert。
// Intro 頁籤與 AI 導演（片頭項目）共用；要匯入的素材（PNG、WAV）由呼叫端的匯入流程處理。
import { renderMusic, renderSound, synthToWav } from "../audio/synth/render";
import type { Media, Project } from "../core/model";
import type { Engine, ImportSource } from "../engine/Engine";
import { builtinPlugins3D } from "../three/builtins";
import { flipIntro, type FlipPlan } from "./flip";
import { flipEffect, type IntroInsert, type IntroSound } from "./insert";
import { INTRO_MUSIC, INTRO_MUSIC_REVEAL, introSoundCues, introSoundSpecs } from "./sounds";

/** V1 佔位素材的檔名（產生過就沿用同一支） */
export const PLACEHOLDER_NAME = "intro-black.png";

/** 做一張 320×180 的黑色 PNG（V1 佔位；片頭特效會整個蓋住，刪掉特效時看到的是黑畫面） */
export async function blackPng(): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(320, 180);
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, 320, 180);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

/** 組片頭的參數 */
export interface BuildIntroOptions {
  project: Project;
  engine: Engine;
  importSources: (sources: ImportSource[]) => Promise<Media[]>;
  imageIds: string[];
  title: string;
  subtitle?: string;
  iconId?: string;
  seed: number;
  fps: number;
  /** 要不要內建配樂（揭曉對準第 3 小節：4 秒、片頭 8 秒） */
  withMusic: boolean;
}

/** 組片頭：回傳要插入的內容與計畫（給提示用：長度、警告） */
export async function buildIntro(o: BuildIntroOptions): Promise<{ intro: IntroInsert; plan: FlipPlan }> {
  const plan = flipIntro({
    imageIds: o.imageIds, title: o.title, subtitle: o.subtitle, iconId: o.iconId, fps: o.fps, seed: o.seed,
    ...(o.withMusic ? { reveal: INTRO_MUSIC_REVEAL, duration: 8 } : {}),
  });
  const plugin = (await builtinPlugins3D()).get("flip-intro")!;
  /** 產生過的素材沿用；沒有就做出來匯入（回傳素材 id） */
  const generated = async (name: string, make: () => Promise<Uint8Array>): Promise<string> => {
    const existing = o.project.media.find((m) => m.name === name);
    if (existing) return existing.id;
    const [media] = await o.importSources([await o.engine.importGenerated(name, await make())]);
    if (!media) throw new Error(`Couldn't make ${name}.`);
    return media.id;
  };
  const placeholderId = await generated(PLACEHOLDER_NAME, blackPng);
  // 音效：每種算一次（上升音長度隨片頭，檔名帶長度）
  const specs = introSoundSpecs(plan);
  const ids: Record<string, string> = {};
  for (const [key, spec] of Object.entries(specs)) {
    const name = key === "riser" ? `intro-riser-${spec.length.toFixed(2)}.wav` : `intro-${key}.wav`;
    ids[key] = await generated(name, async () => synthToWav(await renderSound(spec)));
  }
  const sounds: IntroSound[] = introSoundCues(plan).map((c) => ({ mediaId: ids[c.key], t: c.t, volume: c.volume }));
  const music = o.withMusic ? { mediaId: await generated("intro-music.wav", async () => synthToWav(await renderMusic(INTRO_MUSIC))), srcIn: INTRO_MUSIC_REVEAL - plan.reveal, volume: 0.8 } : undefined;
  const effect = flipEffect(plan, plugin, `intro-${crypto.randomUUID().slice(0, 8)}`, 0);
  return { intro: { effect, plugin, placeholderId, duration: plan.duration, sounds, music }, plan };
}
