// 一鍵片頭寫進時間軸（spec §5.23）：由翻頁式計畫產生全畫面特效的參數，再用一次編輯放進專案——
// V1 開頭漣漪插入佔位素材（scene3d 會整個蓋住）、特效、A3 每聲一個音效片段、A2 配樂片段。整個片頭是一次 Ctrl+Z。
import { produce } from "immer";
import type { Clip, Effect, Plugin, Project, Seconds } from "../core/model";
import { roundTime } from "../core/time";
import { layoutV1Draft, rippleInsertDraft } from "../core/timeline";
import type { FlipPlan } from "./flip";

/**
 * 翻頁式片頭的特效（scene3d，插件 flip-intro）。圖片 id 只列一次（icon 放最後），頁面與標題填圖用索引，
 * 主程式依 imageIds 解碼成插件的 env.images。
 */
export function flipEffect(plan: FlipPlan, plugin: Plugin, id: string, start: Seconds): Effect {
  const t = plan;
  const imageIds = [...new Set([...plan.pageImages, ...plan.titleFills])];
  if (t.iconId && !imageIds.includes(t.iconId)) imageIds.push(t.iconId);
  const index = (imageId: string) => imageIds.indexOf(imageId);
  const component = plugin.component as { params?: Record<string, { default?: unknown }> };
  const defaults = Object.fromEntries(Object.entries(component.params ?? {}).map(([k, d]) => [k, d.default]));
  const pages = plan.cues.filter((c) => c.kind === "page");
  const at = (kind: string) => plan.cues.find((c) => c.kind === kind)?.t ?? 0;
  return {
    id, kind: "scene3d", start, end: roundTime(start + plan.duration), pluginId: plugin.hash, anchorIds: [],
    params: {
      title: "Flip intro", template: "flip-intro",
      params: {
        ...defaults,
        imageIds,
        pages: pages.map((c, i) => ({ t: c.t, img: index(plan.pageImages[i]), strength: c.strength ?? 1 })),
        titleFills: plan.titleFills.map(index),
        icon: t.iconId ? index(t.iconId) : null,
        montageStart: pages[0]?.t ?? 0,
        flash: at("flash"),
        titleIn: at("titleIn"),
        reveal: plan.reveal,
        title: t.title,
        subtitle: t.subtitle ?? "",
      },
    },
  };
}

/** 一個音效擺位（相對片頭開頭） */
export interface IntroSound {
  mediaId: string;
  t: Seconds;
  volume: number;
}

/** 要插進時間軸的片頭 */
export interface IntroInsert {
  /** 特效（start 會改成插入點） */
  effect: Effect;
  plugin: Plugin;
  /** V1 佔位素材（圖片） */
  placeholderId: string;
  duration: Seconds;
  sounds: IntroSound[];
  /** 配樂：從素材的 srcIn 開始放，長度到片頭結尾 */
  music?: { mediaId: string; srcIn: Seconds; volume: number };
}

/** 結尾配樂淡出秒數 */
const MUSIC_FADE_OUT: Seconds = 0.6;

/**
 * 在時間軸開頭插入片頭：其他未鎖定軌往後移 duration（漣漪插入），放入佔位、特效、音效與配樂。
 * 音效軌或配樂軌鎖住、或素材找不到時，那部分略過（畫面照放）。
 */
export function insertIntro(project: Project, intro: IntroInsert): Project {
  const tracks = [...project.tracks].sort((a, b) => a.index - b.index);
  const v1 = tracks.find((t) => t.kind === "video");
  if (!v1 || v1.locked) return project;
  const sfx = tracks.find((t) => t.kind === "audio" && t.role === "sfx" && !t.locked);
  const music = tracks.find((t) => t.kind === "audio" && t.role === "music" && !t.locked);
  const mediaOf = (id: string) => project.media.find((m) => m.id === id);
  const d = roundTime(intro.duration);
  return produce(project, (draft) => {
    rippleInsertDraft(draft, 0, d);
    const ids = new Set(draft.clips.map((c) => c.id));
    /** 不重複的片段 id */
    const newId = (base: string) => {
      let id = base;
      for (let n = 2; ids.has(id); n++) id = `${base}-${n}`;
      ids.add(id);
      return id;
    };
    const clip = (c: Omit<Clip, "id" | "speed" | "opacity" | "fadeIn" | "fadeOut"> & Partial<Clip>, base: string): Clip =>
      ({ id: newId(base), speed: 1, opacity: 1, fadeIn: 0, fadeOut: 0, ...c });
    draft.clips.push(clip({ mediaId: intro.placeholderId, trackId: v1.id, srcIn: 0, srcOut: d, start: 0, volume: 1 }, `intro@${v1.id}`));
    draft.effects.push({ ...intro.effect, start: 0, end: d });
    if (!draft.plugins.some((p) => p.hash === intro.plugin.hash)) draft.plugins.push(intro.plugin);
    if (sfx) {
      for (const s of intro.sounds) {
        const m = mediaOf(s.mediaId);
        if (!m || s.t >= d) continue;
        draft.clips.push(clip({ mediaId: s.mediaId, trackId: sfx.id, srcIn: 0, srcOut: roundTime(Math.min(m.duration, d - s.t)), start: roundTime(s.t), volume: s.volume }, `intro-sfx@${sfx.id}`));
      }
    }
    const mm = intro.music && mediaOf(intro.music.mediaId);
    if (music && intro.music && mm) {
      const len = Math.min(d, mm.duration - intro.music.srcIn);
      if (len > 0) draft.clips.push(clip({ mediaId: mm.id, trackId: music.id, srcIn: intro.music.srcIn, srcOut: roundTime(intro.music.srcIn + len), start: 0, volume: intro.music.volume, fadeOut: Math.min(MUSIC_FADE_OUT, len) }, `intro-music@${music.id}`));
    }
    layoutV1Draft(draft);
  });
}
