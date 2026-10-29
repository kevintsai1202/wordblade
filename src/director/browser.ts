// AI 導演在瀏覽器裡要做的事（docs/plan-10-29-director2.md）：拼縮圖總表（給審查者）、套用剪輯腳本時各項要跑的 AI 或匯入
// （遮罩、Vibe特效、3D 範本、AI 配樂、片頭）。純邏輯在 apply.ts、run.ts；這裡接 Engine、閘道、沙盒。
import { GatewayClient, type GatewaySettings } from "../ai/gateway";
import { runMusic } from "../ai/synth";
import { runVibe } from "../ai/vibe";
import type { PluginService } from "../anim/pluginService";
import { renderMusic, synthToWav } from "../audio/synth/render";
import type { DirectorChapter, Media, Project, Suggestion } from "../core/model";
import type { Engine, ImportSource } from "../engine/Engine";
import { buildIntro } from "../intro/build";
import { runMaskJob, runTextMaskJob } from "../sam/runMask";
import { grabJpegs } from "../sam/frames";
import { targetRoute } from "../sam/locate";
import { TEMPLATES_3D, builtinPlugins3D, template3DEffect } from "../three/builtins";
import type { ApplyDeps } from "./apply";
import type { DirectorSuggestion } from "./api";
import { maskFromBox } from "./suggestions";

/** 縮圖總表：每列幾格、每格寬、標籤列高 */
const SHEET_COLS = 4;
const CELL_W = 480;
const LABEL_H = 30;
/** 一張總表最多幾格（太多就只放前面的） */
const SHEET_MAX = 32;

/** 素材的畫面來源：有代理檔用代理檔（快），否則原檔 */
export async function frameSource(engine: Engine, media: Media): Promise<Blob | string> {
  return media.proxyPath ? engine.mediaUrl(media) : engine.exportSource(media);
}

/**
 * 縮圖總表（給審查者；熱庫「用縮圖總表讓 LLM 理解影片」）：每項開頭各取一格（原檔、寬 480），拼成每列 4 格的一張 JPEG，
 * 每格上方黑底白字標上項目 id、種類與秒數，讓模型一次看完所有時間點。
 */
export async function buildContactSheet(source: Blob | string, items: DirectorSuggestion[]): Promise<Blob | null> {
  const list = items.slice(0, SHEET_MAX);
  if (!list.length) return null;
  const jpegs = await grabJpegs(source, list.map((s) => s.start + 0.3), CELL_W);
  const bitmaps = await Promise.all(jpegs.map((b) => (b.length ? createImageBitmap(new Blob([b as Uint8Array<ArrayBuffer>], { type: "image/jpeg" })).catch(() => null) : Promise.resolve(null))));
  const cellH = Math.round((CELL_W * 9) / 16);
  const rows = Math.ceil(list.length / SHEET_COLS);
  const canvas = new OffscreenCanvas(SHEET_COLS * CELL_W, rows * (cellH + LABEL_H));
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#fff";
  g.fillRect(0, 0, canvas.width, canvas.height);
  list.forEach((s, i) => {
    const x = (i % SHEET_COLS) * CELL_W;
    const y = Math.floor(i / SHEET_COLS) * (cellH + LABEL_H);
    const bmp = bitmaps[i];
    if (bmp) g.drawImage(bmp, x, y + LABEL_H, CELL_W, cellH);
    g.fillStyle = "#000";
    g.fillRect(x, y, CELL_W, LABEL_H);
    g.fillStyle = "#fff";
    g.font = "bold 18px Arial, sans-serif";
    g.fillText(`${s.id}  ${s.kind}  ${s.start.toFixed(1)}s`, x + 8, y + 21);
    bmp?.close();
  });
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.8 });
}

/** 原檔某一秒的畫面（data URL，給 Vibe特效當參考圖） */
async function frameDataUrl(source: Blob | string, t: number): Promise<string | null> {
  const [jpeg] = await grabJpegs(source, [t], 960);
  if (!jpeg?.length) return null;
  const blob = new Blob([jpeg as Uint8Array<ArrayBuffer>], { type: "image/jpeg" });
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/** 建議裡的框 → 目標框（中心＋寬高；0～1） */
function boxOf(s: Suggestion): { cx: number; cy: number; w: number; h: number } | null {
  const [x, y, w, h] = ["x", "y", "w", "h"].map((k) => s.payload[k]);
  if (![x, y, w, h].every((v) => typeof v === "number")) return null;
  return { cx: (x as number) + (w as number) / 2, cy: (y as number) + (h as number) / 2, w: w as number, h: h as number };
}

/** 套用剪輯腳本要的各步驟 */
export function makeApplyDeps(o: {
  project: () => Project;
  engine: Engine;
  plugins: PluginService;
  media: Media;
  chapters: DirectorChapter[];
  settings: GatewaySettings;
  importSources: (sources: ImportSource[]) => Promise<Media[]>;
  fps: number;
  onProgress?: ApplyDeps["onProgress"];
}): ApplyDeps {
  const source = frameSource(o.engine, o.media);
  const gateway = new GatewayClient(o.settings);
  /** 匯入一個程式產生的檔案，回傳素材 id */
  const importGenerated = async (name: string, bytes: Uint8Array): Promise<string> => {
    const [m] = await o.importSources([await o.engine.importGenerated(name, bytes)]);
    if (!m) throw new Error(`Couldn't import ${name}.`);
    return m.id;
  };
  return {
    onProgress: o.onProgress,
    async mask(s) {
      // 螢幕上的文字類個資交給 Spark 每秒 1 格找框；人、臉等跑 SAM；都找不到退回導演給的框
      const target = String(s.payload.target);
      const result = targetRoute(target) === "spark"
        ? await runTextMaskJob({ engine: o.engine, media: o.media, phrase: target, start: s.start, end: s.end })
        : await runMaskJob({ engine: o.engine, media: o.media, phrase: target, start: s.start, end: s.end, fps: 10 });
      if (result.objects.length) return result.objects;
      const box = maskFromBox(s, `mask-${crypto.randomUUID().slice(0, 8)}`);
      return box ? [box] : [];
    },
    async effect(s, span) {
      const screenshot = await frameDataUrl(await source, Math.min(s.end, s.start + 0.5));
      const outcome = await runVibe(gateway, o.plugins.host, await o.plugins.builtins(), {
        description: String(s.payload.description), screenshot, start: span.start, duration: span.end - span.start,
        box: boxOf(s) ?? { cx: 0.5, cy: 0.5, w: 0.3, h: 0.2 }, aspect: 16 / 9, fps: o.fps, effectId: `fx-${crypto.randomUUID().slice(0, 8)}`,
      }, () => undefined);
      if (!outcome.ok) throw new Error(outcome.message);
      return { effect: outcome.effect, plugins: outcome.plugins };
    },
    async scene(s, span) {
      const id = s.kind === "mascot" ? (s.payload.action === "wave" ? "mascot-wave" : "mascot-point") : String(s.payload.scene);
      const template = TEMPLATES_3D.find((t) => t.id === id);
      if (!template) throw new Error("Unknown 3D scene.");
      const plugin = (await builtinPlugins3D()).get(template.componentId)!;
      const effect = template3DEffect(template, plugin, `fx-${crypto.randomUUID().slice(0, 8)}`, span.start, span.end - span.start);
      const box = s.kind === "mascot" ? boxOf(s) : null;
      if (box) effect.params = { ...effect.params, box };
      return { effect, plugins: [plugin] };
    },
    async music(s) {
      const outcome = await runMusic(gateway, { description: String(s.payload.description), bars: 16 });
      if (!outcome.ok) throw new Error(outcome.message);
      return importGenerated(`music-director-${crypto.randomUUID().slice(0, 6)}.wav`, synthToWav(await renderMusic(outcome.spec)));
    },
    async intro(s) {
      // 封面：各章節開頭（+1 秒）的畫面，不夠 8 張就在全片平均補；不花 AI 費用
      const times = o.chapters.map((c) => c.start + 1);
      for (let i = 0; times.length < 8 && i < 12; i++) times.push(((i + 0.5) / 12) * o.media.duration);
      const jpegs = await grabJpegs(await source, times.slice(0, 8).sort((a, b) => a - b), 1280);
      const ids: string[] = [];
      for (const [i, jpeg] of jpegs.entries()) if (jpeg.length) ids.push(await importGenerated(`intro-cover-${i + 1}.jpg`, jpeg));
      if (!ids.length) return null;
      const { intro } = await buildIntro({
        project: o.project(), engine: o.engine, importSources: o.importSources, imageIds: ids,
        title: String(s.payload.title), subtitle: String(s.payload.subtitle ?? "") || undefined, seed: 1, fps: o.fps, withMusic: true,
      });
      return intro;
    },
  };
}
