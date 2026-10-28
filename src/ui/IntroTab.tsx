// Intro 子頁籤（spec §5.23、D34）：一鍵片頭「翻頁式」——勾選素材庫裡的封面圖、填標題（副標、icon 選填），
// 按 Generate 就在時間軸開頭插入整段片頭（V1 佔位＋全畫面 3D 特效、A3 翻頁／上升音／重擊、A2 內建配樂），一次 Ctrl+Z 復原。
// 音效與配樂都是宣告式 spec 在本機合成（intro/sounds.ts），同一個檔名產生過就沿用。
// 同一個 seed 結果相同；Shuffle 換一組洗牌。
import { useMemo, useState, type Dispatch } from "react";
import type { Media, Project } from "../core/model";
import type { Engine, ImportSource } from "../engine/Engine";
import { flipIntro, FLIP_MIN_IMAGES } from "../intro/flip";
import { flipEffect, type IntroSound } from "../intro/insert";
import { INTRO_MUSIC, INTRO_MUSIC_REVEAL, introSoundCues, introSoundSpecs } from "../intro/sounds";
import { renderMusic, renderSound, synthToWav } from "../audio/synth/render";
import { builtinPlugins3D } from "../three/builtins";
import { FPS, type Action } from "./state";

/** V1 佔位素材的檔名（產生過就沿用同一支） */
const PLACEHOLDER_NAME = "intro-black.png";

/** 做一張 320×180 的黑色 PNG（V1 佔位；片頭特效會整個蓋住，刪掉特效時看到的是黑畫面） */
async function blackPng(): Promise<Uint8Array> {
  const canvas = new OffscreenCanvas(320, 180);
  const g = canvas.getContext("2d")!;
  g.fillStyle = "#000";
  g.fillRect(0, 0, 320, 180);
  return new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
}

/** Intro 頁籤 */
export function IntroTab({ project, engine, importSources, dispatch }: {
  project: Project;
  engine: Engine;
  importSources: (sources: ImportSource[]) => Promise<Media[]>;
  dispatch: Dispatch<Action>;
}) {
  /** 素材庫裡的圖片（佔位圖不算） */
  const images = useMemo(() => project.media.filter((m) => m.kind === "image" && m.name !== PLACEHOLDER_NAME), [project.media]);
  /** 沒勾的圖片（預設全勾，新匯入的圖也自動算進來） */
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [title, setTitle] = useState("");
  const [subtitle, setSubtitle] = useState("");
  const [iconId, setIconId] = useState("");
  const [seed, setSeed] = useState(1);
  /** 要不要內建配樂（有配樂時揭曉對準第 3 小節：4 秒、片頭 8 秒） */
  const [withMusic, setWithMusic] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const chosen = images.filter((m) => !unchecked.has(m.id) && m.id !== iconId);
  const toggle = (id: string) => setUnchecked((s) => {
    const next = new Set(s);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });

  /** 產生並插入片頭 */
  const generate = async () => {
    setBusy(true);
    setNotice(null);
    try {
      const plan = flipIntro({
        imageIds: chosen.map((m) => m.id), title: title.trim(), subtitle: subtitle.trim() || undefined, iconId: iconId || undefined, fps: FPS, seed,
        ...(withMusic ? { reveal: INTRO_MUSIC_REVEAL, duration: 8 } : {}),
      });
      const plugin = (await builtinPlugins3D()).get("flip-intro")!;
      /** 產生過的素材沿用；沒有就做出來匯入（回傳素材 id） */
      const generated = async (name: string, make: () => Promise<Uint8Array>): Promise<string> => {
        const existing = project.media.find((m) => m.name === name);
        if (existing) return existing.id;
        const [media] = await importSources([await engine.importGenerated(name, await make())]);
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
      const music = withMusic ? { mediaId: await generated("intro-music.wav", async () => synthToWav(await renderMusic(INTRO_MUSIC))), srcIn: INTRO_MUSIC_REVEAL - plan.reveal, volume: 0.8 } : undefined;
      const effect = flipEffect(plan, plugin, `intro-${crypto.randomUUID().slice(0, 8)}`, 0);
      dispatch({ type: "commit", edits: [{ kind: "insertIntro", intro: { effect, plugin, placeholderId, duration: plan.duration, sounds, music } }] });
      dispatch({ type: "seek", time: 0 });
      setNotice(plan.warnings.join(" ") || `Added a ${plan.duration.toFixed(1)} s intro at the start. Ctrl+Z removes it.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!images.length) return <p className="muted placeholder" data-testid="intro-hint">Import some cover images (PNG or JPG) first — {FLIP_MIN_IMAGES} or more look best.</p>;
  return (
    <div className="vibe-tab" data-testid="intro-tab">
      <h3 className="section-title">Flip intro</h3>
      <p className="muted">Covers flip past faster and faster, a flash, then your title punches in.</p>
      <div className="intro-images" data-testid="intro-images">
        {images.map((m) => (
          <label key={m.id} className="intro-image" title={m.name}>
            <input type="checkbox" checked={!unchecked.has(m.id) && m.id !== iconId} disabled={m.id === iconId} onChange={() => toggle(m.id)} />
            <span>{m.name ?? m.id}</span>
          </label>
        ))}
      </div>
      <label className="param-field"><span>Title</span><input data-testid="intro-title" value={title} maxLength={40} onChange={(e) => setTitle(e.target.value)} /></label>
      <label className="param-field"><span>Subtitle</span><input data-testid="intro-subtitle" value={subtitle} maxLength={80} onChange={(e) => setSubtitle(e.target.value)} /></label>
      <label className="param-field"><span>Icon</span>
        <select data-testid="intro-icon" value={iconId} onChange={(e) => setIconId(e.target.value)}>
          <option value="">None</option>
          {images.map((m) => <option key={m.id} value={m.id}>{m.name ?? m.id}</option>)}
        </select>
      </label>
      <label className="intro-image"><input type="checkbox" data-testid="intro-music" checked={withMusic} onChange={(e) => setWithMusic(e.target.checked)} /> Built-in music (title lands on the beat)</label>
      <div className="row">
        <span className="muted">{chosen.length} image{chosen.length === 1 ? "" : "s"} · shuffle #{seed}</span>
        <button type="button" onClick={() => setSeed((s) => s + 1)}>Shuffle</button>
        <span className="spacer" />
        <button type="button" className="primary" data-testid="intro-generate" disabled={busy || !chosen.length || !title.trim()} onClick={() => void generate()}>{busy ? "Generating…" : "Generate intro"}</button>
      </div>
      {notice && <p className="muted" data-testid="intro-notice">{notice}</p>}
    </div>
  );
}
