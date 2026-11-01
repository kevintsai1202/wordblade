// 聲音分離的時間軸編輯（spec §5.14、P1-10）：純函式，「舊專案 → 新專案」，由 history 的 separateStems 編輯呼叫。
import { produce } from "immer";
import type { Clip, Media, Project } from "./model";
import { freeTrackId } from "./voiceover";

/** 分離用的模型名稱（記在 Project.stems 裡） */
export const STEM_MODEL = "Kim_Vocal_2";

/**
 * 分離完成後的一次編輯：
 * - 原素材的每個「音軌上的片段」換成兩個：人聲留在原軌（位置、修邊、變速、音量、淡入淡出都照舊），
 *   背景音樂放到新增的一條音軌（role="music"）、其他欄位相同；兩者不連動（D15）。影像軌上的片段不動。
 * - 鎖定軌道上的片段不動（不能改鎖定的軌）。
 * - 在原素材記下 stems（人聲、背景是哪兩支素材），並寫一筆 Project.stems。
 * 原素材或兩支衍生素材不在專案裡時原樣回傳。背景片段只有在真的有片段要放時才建新軌。
 */
export function separateStems(project: Project, mediaId: string, vocalsId: string, backgroundId: string): Project {
  const has = (id: string) => project.media.some((m) => m.id === id);
  if (!has(mediaId) || !has(vocalsId) || !has(backgroundId) || vocalsId === backgroundId || mediaId === vocalsId || mediaId === backgroundId) return project;
  return produce(project, (d) => {
    const audioTracks = new Map(d.tracks.filter((t) => t.kind === "audio").map((t) => [t.id, t]));
    // 要換掉的片段：原素材在（未鎖定的）音軌上的片段
    const targets = d.clips.filter((c) => c.mediaId === mediaId && audioTracks.has(c.trackId) && !audioTracks.get(c.trackId)!.locked);
    let musicTrackId: string | null = null;
    if (targets.length) {
      const index = d.tracks.filter((t) => t.kind === "audio").reduce((max, t) => Math.max(max, t.index), -1) + 1;
      musicTrackId = freeTrackId(project);
      d.tracks.push({ id: musicTrackId, kind: "audio", role: "music", index, muted: false, locked: false, volume: 1 });
    }
    // 已用的片段 id，產生新片段 id 時避開
    const used = new Set(d.clips.map((c) => c.id));
    /** 產生不重複的片段 id */
    const fresh = (base: string): string => {
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      return id;
    };
    const replaced = new Set(targets.map((c) => c.id));
    const next: Clip[] = [];
    for (const c of d.clips) {
      if (!replaced.has(c.id)) {
        next.push(c);
        continue;
      }
      next.push({ ...c, id: fresh(`${vocalsId}@${c.trackId}`), mediaId: vocalsId });
      next.push({ ...c, id: fresh(`${backgroundId}@${musicTrackId}`), mediaId: backgroundId, trackId: musicTrackId! });
    }
    d.clips = next;
    const source = d.media.find((m) => m.id === mediaId) as Media;
    source.stems = { vocalsId, backgroundId };
    d.stems = [...d.stems.filter((s) => s.mediaId !== mediaId), { mediaId, vocalsId, backgroundId, model: STEM_MODEL }];
  });
}

/**
 * 轉錄與重配音取樣該從哪支素材抽音訊：素材有分離出的人聲（而且人聲還在專案裡、沒離線）就用人聲，否則用素材本身。
 * 人聲與原素材同長、同時間軸（都從 0 開始），所以時間不用換算；逐字稿仍記在原素材上。
 */
export function audioSourceFor(project: Project, media: Media): Media {
  const vocals = media.stems && project.media.find((m) => m.id === media.stems!.vocalsId);
  return vocals && !vocals.offline ? vocals : media;
}

/** 反查：這支素材若是某支原素材的人聲，回那支原素材（對白軌放的是人聲時，重配音要拿原素材的逐字稿）；不是就回它自己 */
export function sourceOfVocals(project: Project, media: Media): Media {
  return project.media.find((m) => m.stems?.vocalsId === media.id) ?? media;
}
