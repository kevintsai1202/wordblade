import { expect, test, type Page } from "@playwright/test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openTab } from "./helpers/tabs";

// Demo 影片（3 分鐘內）用 WordBlade 自己剪（docs/demo-script.md「剪輯表」）：腳本操作 WordBlade 網頁版——
// 匯入錄影（output/demo-rec）、吉祥物樣片、特效範例成品、旁白（output/demo-voice/drama-3）、字卡（scripts/demo/cards.mjs）→
// V1 依序接片段（入出點＋變速，等待的地方快轉）→ A1 放每句旁白 → V2 放功能角標 → 轉場 → 3D 吉祥物穿插 →
// 一鍵片頭（Flip intro，封面是各功能畫面）→ AI 配樂鋪滿 → 匯出。剪輯動作走開發用鉤子（和 UI 同一個 dispatch／commit）。
// 連線上閘道（片頭配樂、AI 配樂），本機 dev server：
//   $env:WORDBLADE_LIVE_TOKEN = '<權杖>'; $env:WORDBLADE_E2E_PORT = '1420'
//   node scripts/demo/cards.mjs; pnpm playwright test e2e/demo-cut-live.spec.ts
// 產出：output/demo-cut/wordblade-demo.mp4、timeline.json（實際剪輯表）
const token = process.env.WORDBLADE_LIVE_TOKEN;
const GATEWAY = process.env.WORDBLADE_LIVE_GATEWAY ?? "https://wordblade-api.zeabur.app";
const ROOT = path.join(import.meta.dirname, "..");
const OUT = path.join(ROOT, "output", "demo-cut");
const VOICE = path.join(ROOT, "output", "demo-voice", "drama-3");

test.skip(!token, "沒有設 WORDBLADE_LIVE_TOKEN");

/** 素材代號 → 檔案 */
const FILES: Record<string, string> = {
  stage: "output/demo-3d/two-stage.mp4",
  raw: "public/sample/media/demo-2min.mp4",
  fx: "output/sample-effects-export.mp4",
  S1: "output/demo-rec/S1-transcript.mp4",
  S2: "output/demo-rec/S2-director.mp4",
  S3: "output/demo-rec/S3-mask.mp4",
  S4: "output/demo-rec/S4-vibe.mp4",
  S5: "output/demo-rec/S5-scene3d.mp4",
  S6: "output/demo-rec/S6-finish.mp4",
  end: "output/demo-cut/cards/end.png",
};

/**
 * 剪輯表：每段配哪幾句旁白（lines）、用哪些素材窗（[代號, 入點, 出點]，素材秒數）、左上角標（label）。
 * 段長＝那幾句旁白的長度＋間隔；各窗依素材長度比例分配，倍速夾在 0.5～4（等待的地方快轉）。
 * sizzle 段沒有旁白，原速、接點放轉場；片尾是片尾卡（圖片）。
 */
const PLAN: { id: string; lines: string[]; windows: [string, number, number][]; label?: string; transition?: string; fixed?: number }[] = [
  { id: "open", lines: ["01", "02"], windows: [["stage", 0, 10], ["fx", 54, 57.5]] },
  { id: "problem", lines: ["03", "04"], windows: [["raw", 3, 23]], transition: "dissolve" },
  { id: "asr1", lines: ["05"], windows: [["S1", 0, 8]], label: "label-asr", transition: "pushLeft" },
  { id: "asr2", lines: ["06"], windows: [["S1", 8, 44]], label: "label-asr" },
  { id: "director", lines: ["07", "08"], windows: [["S2", 36, 48], ["S2", 340, 379]], label: "label-director", transition: "pushLeft" },
  { id: "sam", lines: ["09"], windows: [["S3", 10, 48]], label: "label-sam", transition: "pushLeft" },
  { id: "vibe", lines: ["10", "11"], windows: [["S4", 8, 22], ["S4", 22, 36], ["S4", 36, 46], ["S4", 46, 58], ["S4", 84, 96]], label: "label-vibe", transition: "pushLeft" },
  { id: "scene", lines: ["12"], windows: [["S5", 6, 26]], label: "label-scene", transition: "zoomIn" },
  { id: "publish", lines: ["13"], windows: [["S6", 40, 56], ["S6", 62, 88]], label: "label-publish", transition: "pushLeft" },
  { id: "compositor", lines: ["14"], windows: [["fx", 26, 32], ["fx", 69, 74]], label: "label-compositor", transition: "dissolve" },
  { id: "sizzle", lines: [], windows: [["fx", 96, 101], ["stage", 3, 10], ["fx", 54, 57]], transition: "zoomIn" },
  { id: "end", lines: ["15"], windows: [["end", 0, 0]], transition: "dissolve", fixed: 0 },
];
/**
 * 局部放大（WordBlade 的 Zoom，素材時間記）：AI 結果出現時拉近到結果區，觀眾看得清楚。[代號, 素材起, 素材訖, 框寬, cx, cy]
 */
const ZOOMS: [string, number, number, number, number, number][] = [
  ["S1", 24, 44, 0.5, 0.85, 0.4],     // 逐字稿刪字
  ["S2", 352, 379, 0.45, 0.86, 0.45], // 導演建議清單
  ["S3", 32, 48, 0.55, 0.38, 0.3],    // 金鑰被馬賽克
  ["S4", 37, 46, 0.5, 0.42, 0.42],    // It works!
  ["S4", 86, 96, 0.5, 0.42, 0.4],     // 3D 獎盃
  ["S6", 66, 80, 0.45, 0.88, 0.35],   // 發佈包的標題
];
/** 放大的框寬（2 倍左右）與一組操作點之間最多隔幾秒算同一段放大 */
const ZOOM_W = 0.55;
const CLUSTER_GAP = 4;
type Mark = { t: number; x: number; y: number; w: number; h: number; what: string };
/** 錄影的操作點（e2e/demo-record-live.spec.ts 錄的時候記下；沒有就空的） */
function marksOf(key: string): Mark[] {
  const f = path.join(ROOT, FILES[key].replace(/\.mp4$/, ".marks.json"));
  return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Mark[]) : [];
}
/** 框中心夾在框不會超出畫面（同 src/core/zoom.ts clampCenter） */
const clampC = (c: number, w: number) => Math.min(1 - w / 2, Math.max(w / 2, c));
/**
 * 一支錄影的放大區段：操作點（每次點擊、打字）與結果（RESULTS）依時間排好，相隔 CLUSTER_GAP 秒內的併成一段，
 * 鏡頭沿著各點移動（WordBlade Zoom 的路徑點）；只取剪輯表用到的素材窗裡的點。
 */
function zoomsOf(key: string, windows: [number, number][]) {
  const inUse = (t: number) => windows.some(([a, b]) => t >= a && t <= b);
  const points = [
    ...marksOf(key).filter((m) => inUse(m.t)).map((m) => ({ t: m.t, cx: m.x, cy: m.y, hold: 1.8 })),
    ...ZOOMS.filter((z) => z[0] === key).map(([, a, b, , cx, cy]) => ({ t: a, cx, cy, hold: b - a })),
  ].sort((p, q) => p.t - q.t);
  const regions: { start: number; end: number; path: { src: number; cx: number; cy: number }[] }[] = [];
  for (const p of points) {
    const last = regions.at(-1);
    if (last && p.t - last.end < CLUSTER_GAP) {
      last.end = Math.max(last.end, p.t + p.hold);
      last.path.push({ src: p.t, cx: p.cx, cy: p.cy });
    } else regions.push({ start: Math.max(0, p.t - 1.2), end: p.t + p.hold, path: [{ src: p.t, cx: p.cx, cy: p.cy }] });
  }
  // 素材窗的邊界：放大不跨出用到的窗（夾到窗內）
  return regions.map((r) => {
    const win = windows.find(([a, b]) => r.path[0].src >= a && r.path[0].src <= b)!;
    return { ...r, start: Math.max(r.start, win[0]), end: Math.min(r.end, win[1]) };
  }).filter((r) => r.end - r.start > 0.5);
}
/** 圈選框在畫面上的位置：操作點在放大後的位置（假設已經放大到底；同 src/core/zoom.ts zoomCrop） */
function ringRect(m: Mark, center: { cx: number; cy: number }) {
  const x0 = clampC(center.cx, ZOOM_W) - ZOOM_W / 2, y0 = clampC(center.cy, ZOOM_W) - ZOOM_W / 2;
  return { x: (m.x - x0) / ZOOM_W, y: (m.y - y0) / ZOOM_W, w: m.w / ZOOM_W, h: m.h / ZOOM_W };
}
/** 句子之間留白（秒） */
const GAP = 0.35;

type Clip = { id: string; mediaId: string; trackId: string; start: number; srcIn: number; srcOut: number; speed: number };
type Hook = {
  project: () => { media: { id: string; name: string; duration: number }[]; clips: Clip[]; effects: { id: string; params: Record<string, unknown> }[] };
  dispatch: (a: unknown) => void;
};

/** 一次 commit（和 UI 同一個 dispatch） */
const commit = async (page: Page, edits: unknown[]) => {
  await page.evaluate((e) => (window as unknown as { __wordblade: Hook }).__wordblade.dispatch({ type: "commit", edits: e }), edits);
  // project() 讀的是畫面重繪後才更新的參照：等兩個 animation frame 再讀
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
};
const project = (page: Page) => page.evaluate(() => {
  const p = (window as unknown as { __wordblade: Hook }).__wordblade.project();
  return { media: p.media.map((m) => ({ id: m.id, name: m.name, duration: m.duration })), clips: p.clips, effects: p.effects.map((e) => ({ id: e.id, params: e.params })) };
});
const clipEnd = (c: Clip) => c.start + (c.srcOut - c.srcIn) / c.speed;
/** 時間軸總長（V1 結尾） */
const v1End = async (page: Page) => Math.max(0, ...(await project(page)).clips.filter((c) => c.trackId === "V1").map(clipEnd));

/** 旁白長度（秒，ffprobe 太慢，讀 WAV 標頭） */
function wavSeconds(file: string) {
  const b = readFileSync(file);
  const rate = b.readUInt32LE(24), ch = b.readUInt16LE(22), bits = b.readUInt16LE(34);
  const at = b.indexOf("data", 12, "latin1");
  return (b.length - at - 8) / (rate * ch * (bits / 8));
}

test("Demo 影片：WordBlade 剪 3 分鐘 demo → 匯出", async ({ page }) => {
  test.setTimeout(3_000_000);
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.addInitScript(([url, tok]) => {
    localStorage.setItem("wordblade.gateway", JSON.stringify({ url, token: tok }));
    for (const k of ["audio", "intro"]) localStorage.setItem(`wordblade.consent.${k}`, "yes");
    localStorage.setItem("wordblade.exportToOpfs", "1");
    localStorage.setItem("wordblade.dev", "1");
  }, [GATEWAY, token!]);
  // 圈選框的 PNG（透明背景、青綠色圓角框＋光暈），每個操作點一張
  const rings: { key: string; t: number; file: string }[] = [];
  const winsOf = (key: string) => PLAN.flatMap((seg) => seg.windows.filter((w) => w[0] === key).map(([, a, b]) => [a, b] as [number, number]));
  {
    const ringPage = await page.context().newPage();
    await ringPage.setViewportSize({ width: 1920, height: 1080 });
    mkdirSync(path.join(OUT, "rings"), { recursive: true });
    for (const key of Object.keys(FILES)) {
      const zones = zoomsOf(key, winsOf(key));
      for (const [i, m] of marksOf(key).entries()) {
        const z = zones.find((r) => m.t >= r.start && m.t <= r.end);
        if (!z) continue;
        const r = ringRect(m, z.path.find((p) => p.src === m.t) ?? z.path[0]);
        const pad = 14;
        const file = path.join(OUT, "rings", `ring-${key}-${i}.png`);
        await ringPage.setContent(`<!doctype html><body style="margin:0;width:1920px;height:1080px;background:transparent"><div style="position:absolute;left:${r.x * 1920 - pad}px;top:${r.y * 1080 - pad}px;width:${r.w * 1920 + 2 * pad}px;height:${r.h * 1080 + 2 * pad}px;border:6px solid #2fe0c0;border-radius:18px;box-shadow:0 0 28px #2fe0c0, inset 0 0 18px rgba(47,224,192,.5)"></div></body>`);
        await ringPage.screenshot({ path: file, omitBackground: true });
        rings.push({ key, t: m.t, file });
      }
    }
    await ringPage.close();
  }
  await page.goto("/");

  // ① 先只匯入片頭封面，做一鍵片頭（Flip intro 會用素材庫裡全部的圖片當封面，所以角標卡之後才匯入）
  const covers = readdirSync(path.join(OUT, "covers")).filter((f) => f.endsWith(".png")).map((f) => path.join(OUT, "covers", f));
  let chooser = page.waitForEvent("filechooser");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(covers);
  await expect(page.locator(".media-item")).toHaveCount(covers.length, { timeout: 120_000 });
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 120_000 });
  await openTab(page, "intro");
  await page.getByTestId("intro-title").fill("WordBlade");
  await page.getByTestId("intro-subtitle").fill("edit video by editing words");
  await page.getByTestId("intro-generate").click();
  await expect(page.getByTestId("intro-notice")).toContainText("intro at the start", { timeout: 180_000 });
  const introLen = await v1End(page);

  // ② 其他素材（影片、片尾卡、每句旁白、角標）
  const lines = PLAN.flatMap((s) => s.lines);
  const labels = [...new Set(PLAN.map((s) => s.label).filter(Boolean))] as string[];
  const files = [
    ...Object.values(FILES).map((f) => path.join(ROOT, f)),
    ...lines.map((l) => path.join(VOICE, `${l}.wav`)),
    ...labels.map((l) => path.join(OUT, "cards", `${l}.png`)),
    path.join(OUT, "cards", "edited.png"),
    path.join(OUT, "cards", "speed.png"),
    ...rings.map((r) => r.file),
  ];
  chooser = page.waitForEvent("filechooser");
  await openTab(page, "media");
  await page.getByTestId("import-media").click();
  await (await chooser).setFiles(files);
  // 片頭會另外加自己的音效與配樂素材，所以不比數量，等每個檔名都出現
  const names = files.map((f) => path.basename(f));
  await expect.poll(async () => { const have = new Set((await project(page)).media.map((m) => m.name)); return names.filter((n) => !have.has(n)).length; }, { timeout: 180_000 }).toBe(0);
  await expect(page.getByTestId("media-status")).toHaveCount(0, { timeout: 300_000 });
  const media = (await project(page)).media;
  /** 檔名 → 素材 id */
  const idOf = (file: string) => {
    const m = media.find((x) => x.name === path.basename(file));
    if (!m) throw new Error(`找不到素材 ${file}`);
    return m.id;
  };

  // V1：依剪輯表一段一段往後接
  /** 快轉的時間範圍（時間軸），之後放快轉角標 */
  const fast: { a: number; b: number }[] = [];
  /** 每個素材窗在時間軸上的位置（素材 [a, b] → 時間軸起點、倍速） */
  const placed: { key: string; a: number; b: number; start: number; speed: number }[] = [];
  const table: { id: string; start: number; end: number; windows: { src: string; a: number; b: number; speed: number }[] }[] = [];
  for (const seg of PLAN) {
    const segStart = await v1End(page);
    const voice = seg.lines.reduce((s, l) => s + wavSeconds(path.join(VOICE, `${l}.wav`)) + GAP, 0);
    const srcTotal = seg.windows.reduce((s, [, a, b]) => s + (b - a), 0);
    const target = seg.lines.length ? voice + 0.3 : srcTotal;
    const used: { src: string; a: number; b: number; speed: number }[] = [];
    for (const [i, [key, a, b]] of seg.windows.entries()) {
      const mediaId = idOf(FILES[key]);
      const at = await v1End(page);
      await commit(page, [{ kind: "place", mediaId, trackId: "V1", t: at }]);
      let p = await project(page);
      const clip = p.clips.filter((c) => c.trackId === "V1" && c.mediaId === mediaId).sort((x, y) => y.start - x.start)[0];
      // 影片自己的聲音（A1）拿掉：旁白放 A1，素材的聲音不要
      const audio = p.clips.filter((c) => c.trackId.startsWith("A") && c.mediaId === mediaId && Math.abs(c.start - clip.start) < 1e-3);
      if (audio.length) await commit(page, audio.map((c) => ({ kind: "delete", clipId: c.id })));
      if (key === "end") {
        // 片尾卡（圖片）：長度＝最後一句旁白＋1 秒
        await commit(page, [{ kind: "trim", clipId: clip.id, edge: "out", t: clip.start + target + 1 }]);
        used.push({ src: key, a: 0, b: target + 1, speed: 1 });
        continue;
      }
      await commit(page, [{ kind: "trim", clipId: clip.id, edge: "in", t: clip.start + a }]);
      p = await project(page);
      const c2 = p.clips.find((c) => c.id === clip.id)!;
      await commit(page, [{ kind: "trim", clipId: clip.id, edge: "out", t: c2.start + (b - a) }]);
      // 倍速：這一窗分到的長度＝段長 × 素材比例
      const share = seg.lines.length ? (target * (b - a)) / srcTotal : b - a;
      const speed = Math.min(4, Math.max(0.5, Math.round(((b - a) / share) * 100) / 100));
      if (Math.abs(speed - 1) > 0.01) await commit(page, [{ kind: "setSpeed", clipId: clip.id, speed }]);
      // 段的第一個窗放轉場（進場）
      if (i === 0 && seg.transition) await commit(page, [{ kind: "setTransition", clipId: clip.id, transition: seg.transition, duration: 0.6 }]);
      used.push({ src: key, a, b, speed });
      placed.push({ key, a, b, start: clip.start, speed });
      if (speed >= 2) fast.push({ a: clip.start, b: clip.start + (b - a) / speed });
    }
    table.push({ id: seg.id, start: segStart, end: await v1End(page), windows: used });
  }

  // 局部放大：跟著操作點移動、結果出現時停在結果（WordBlade Zoom，素材時間記）
  const zoomEdits = Object.keys(FILES).flatMap((key) => zoomsOf(key, winsOf(key)).map((r, i) => ({
    kind: "addZoom", zoom: { id: `zoom-${key}-${i}`, mediaId: idOf(FILES[key]), start: r.start, end: r.end, w: ZOOM_W, path: r.path.map((p) => ({ src: p.src, cx: clampC(p.cx, ZOOM_W), cy: clampC(p.cy, ZOOM_W) })), enabled: true },
  })));
  if (zoomEdits.length) await commit(page, zoomEdits);

  // A1：每句旁白放在它那一段的開頭起（句與句之間 GAP）
  for (const [i, seg] of PLAN.entries()) {
    let t = table[i].start + 0.25;
    for (const l of seg.lines) {
      await commit(page, [{ kind: "place", mediaId: idOf(path.join(VOICE, `${l}.wav`)), trackId: "A1", t }]);
      t += wavSeconds(path.join(VOICE, `${l}.wav`)) + GAP;
    }
  }

  // V2：左上角功能角標（整段）；開場第二句時下方字卡「This video was edited by WordBlade」
  const overlay = async (file: string, a: number, b: number, track = "V2") => {
    const mediaId = idOf(file);
    await commit(page, [{ kind: "place", mediaId, trackId: track, t: a }]);
    const c = (await project(page)).clips.filter((x) => x.trackId === track && x.mediaId === mediaId).sort((x, y) => y.start - x.start)[0];
    await commit(page, [{ kind: "trim", clipId: c.id, edge: "out", t: b }]);
  };
  for (const [i, seg] of PLAN.entries()) if (seg.label) await overlay(path.join(OUT, "cards", `${seg.label}.png`), table[i].start + 0.4, table[i].end - 0.2);
  const line01 = wavSeconds(path.join(VOICE, "01.wav")) + GAP + 0.25;
  await overlay(path.join(OUT, "cards", "edited.png"), line01, table[0].end - 0.2);
  // 圈選：每個操作點在時間軸上的時間（素材窗換算）亮 1.2 秒
  for (const r of rings) {
    const w = placed.find((p) => p.key === r.key && r.t >= p.a && r.t <= p.b);
    if (!w) continue;
    const at = w.start + (r.t - w.a) / w.speed;
    await overlay(r.file, Math.max(w.start, at - 0.15), at + 1.2);
  }
  // 快轉角標也放 V2（V2 上重疊的片段都會畫，和功能角標同時出現）
  for (const f of fast) if (f.b - f.a > 1) await overlay(path.join(OUT, "cards", "speed.png"), f.a + 0.1, f.b - 0.1);

  // 3D 吉祥物穿插：AI 導演清單出現時從左邊走進來指著右側清單；片尾卡上揮手
  const mascot = async (template: string, a: number, b: number, params: Record<string, unknown>) => {
    await page.evaluate(([s, e]) => (window as unknown as { __wordblade: Hook }).__wordblade.dispatch({ type: "setRange", start: s, end: e }), [a, b]);
    await openTab(page, "vibe3d");
    const before = (await project(page)).effects.length;
    await page.locator(`[data-template="${template}"]`).click();
    await expect.poll(async () => (await project(page)).effects.length).toBe(before + 1);
    const e = (await project(page)).effects.at(-1)!;
    await commit(page, [{ kind: "setEffectParams", effectId: e.id, params: { ...e.params, ...params } }]);
  };
  const dir = table.find((s) => s.id === "director")!;
  await mascot("robot-point", dir.end - 6, dir.end - 0.5, { from: "left", box: { cx: 0.9, cy: 0.45, w: 0.16, h: 0.5 }, height: 0.3 });
  const end = table.find((s) => s.id === "end")!;
  await mascot("robot-wave", end.start + 0.8, end.end, { box: { cx: 0.74, cy: 0.62, w: 0.1, h: 0.2 }, height: 0.42 });

  // AI 配樂：一句描述 → 鋪滿整支（有旁白時自動壓低）
  const total = await v1End(page);
  await page.evaluate(() => (window as unknown as { __wordblade: Hook }).__wordblade.dispatch({ type: "setRange", start: 0, end: 1 }));
  await openTab(page, "audio");
  await page.getByTestId("music-description").fill("Energetic modern tech product launch music, punchy drums, bright synth arps, driving bass, confident and upbeat");
  await page.getByTestId("music-bars").selectOption("16");
  await page.getByTestId("music-generate").click();
  await expect(page.getByTestId("music-result").or(page.getByTestId("music-error"))).toBeVisible({ timeout: 300_000 });
  await expect(page.getByTestId("music-error")).toHaveCount(0);
  await page.getByTestId("music-add").click();
  await expect.poll(async () => (await project(page)).clips.filter((c) => c.trackId === "A2").length, { timeout: 60_000 }).toBeGreaterThan(0);
  const music = (await project(page)).clips.filter((c) => c.trackId === "A2");
  // 片頭自己的配樂留著；AI 配樂從片頭結束鋪到片尾
  const ai = music.sort((x, y) => y.start - x.start)[0];
  await commit(page, [{ kind: "delete", clipId: ai.id }, { kind: "placeLoop", mediaId: ai.mediaId, trackId: "A2", t: introLen, end: total }]);

  writeFileSync(path.join(OUT, "timeline.json"), JSON.stringify({ introLen, total, segments: table }, null, 1));
  console.log(`總長 ${total.toFixed(1)} 秒（片頭 ${introLen.toFixed(1)} 秒）`);
  expect(total).toBeLessThanOrEqual(180);
  await page.screenshot({ path: path.join(OUT, "timeline.png") });

  // 匯出：分塊從 OPFS 讀出來寫檔（整支幾十 MB，一次轉 base64 太大）
  await openTab(page, "export");
  await page.getByTestId("export-start").click();
  await expect(page.getByTestId("export-status")).toContainText("Saved", { timeout: 2_400_000 });
  const file = path.join(OUT, "wordblade-demo.mp4");
  if (existsSync(file)) unlinkSync(file);
  const size = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
    return (await (await dir.getFileHandle("wordblade-export.mp4")).getFile()).size;
  });
  const CHUNK = 8 << 20;
  for (let at = 0; at < size; at += CHUNK) {
    const b64 = await page.evaluate(async ([from, len]) => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("exports");
      const f = await (await dir.getFileHandle("wordblade-export.mp4")).getFile();
      const bytes = new Uint8Array(await f.slice(from, from + len).arrayBuffer());
      let s = "";
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return btoa(s);
    }, [at, CHUNK]);
    appendFileSync(file, Buffer.from(b64, "base64"));
  }
  console.log(`已存 ${path.relative(ROOT, file)}（${(size / 1e6).toFixed(1)} MB）`);
});
