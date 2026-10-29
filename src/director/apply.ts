// AI 導演的剪輯腳本一次套用（docs/plan-10-29-director2.md §5）：使用者勾選的項目照固定順序算出一串編輯，合成一筆（一次 Ctrl+Z 全部回來）。
// 順序：① 素材時間的（剪、改字、遮罩、放大）② 特效、3D 轉場、吉祥物——用「剪過之後」的專案算時間軸範圍 ③ 字幕樣式、配樂 ④ 片頭最後
// （漣漪插入，前面放好的特效、配樂一起往後移）。每一項都在模擬的專案上套一次（applyEdits 是純函式），下一項就用新的時間軸。
// 要跑 AI 或匯入素材的步驟（遮罩、Vibe特效、3D 範本、配樂、片頭）由呼叫端注入；某一項失敗就跳過它、其他照套。
import { applyEdits, type Edit } from "../core/history";
import type { Effect, MaskObject, Plugin, Project, Seconds, Suggestion } from "../core/model";
import type { IntroInsert } from "../intro/insert";
import { adoptEdits, suggestionSpan } from "./suggestions";

/** 時間軸範圍 */
export interface Span {
  start: Seconds;
  end: Seconds;
}

/** 要跑 AI 或匯入素材的步驟 */
export interface ApplyDeps {
  /** 遮罩：文字類交給 Spark、人臉等跑 SAM，找不到就用導演給的框 */
  mask(item: Suggestion): Promise<MaskObject[]>;
  /** 2D 特效：Vibe特效依描述寫插件（參考畫面取原檔那一格） */
  effect(item: Suggestion, span: Span): Promise<{ effect: Effect; plugins: Plugin[] }>;
  /** 3D 轉場、吉祥物：內建範本 */
  scene(item: Suggestion, span: Span): Promise<{ effect: Effect; plugins: Plugin[] }>;
  /** 配樂：AI 依描述作曲、匯入素材庫，回傳素材 id */
  music(item: Suggestion): Promise<string>;
  /** 片頭：封面取各章節開頭的畫面，回傳要插入的片頭（做不出來回 null） */
  intro(item: Suggestion): Promise<IntroInsert | null>;
  /** 進度：做完第幾項 */
  onProgress?(done: number, total: number, item: Suggestion): void;
}

/** 套用結果：要送出的編輯，和沒套成的項目 */
export interface ApplyResult {
  edits: Edit[];
  failed: { id: string; message: string }[];
}

/** 各種類屬於第幾階段 */
const PHASE: Record<Suggestion["kind"], number> = {
  cut: 0, fix: 0, mask: 0, zoom: 0,
  effect: 1, transition: 1, camera: 1, mascot: 1,
  captionStyle: 2, music: 2,
  intro: 3,
};

/** 套用狀態（和那一項的編輯放在一起） */
const applied = (s: Suggestion): Edit => ({ kind: "setSuggestionStatus", id: s.id, status: "applied" });

/** 一項的編輯（在目前模擬的專案上算）；不能套丟錯 */
async function editsFor(p: Project, s: Suggestion, deps: ApplyDeps): Promise<Edit[]> {
  const span = () => {
    const sp = suggestionSpan(p, s);
    if (!sp) throw new Error("This part of the video is no longer on the timeline.");
    return sp;
  };
  switch (s.kind) {
    case "cut":
    case "fix":
    case "zoom": {
      const edits = adoptEdits(p, s);
      if (!edits) throw new Error("This suggestion no longer matches the transcript.");
      return edits;
    }
    case "mask": {
      const masks = await deps.mask(s);
      if (!masks.length) throw new Error(`No "${String(s.payload.target)}" found in this part.`);
      return [{ kind: "addMasks", masks }, applied(s)];
    }
    case "effect": {
      const { effect, plugins } = await deps.effect(s, span());
      return [{ kind: "addEffect", effect, plugins }, applied(s)];
    }
    case "transition":
    case "camera":
    case "mascot": {
      const { effect, plugins } = await deps.scene(s, span());
      return [{ kind: "addEffect", effect, plugins }, applied(s)];
    }
    case "captionStyle":
      return [{ kind: "setCaptionStyle", style: { karaoke: s.payload.karaoke as "off" | "fill" | "scale" | "box" } }, applied(s)];
    case "music": {
      const mediaId = await deps.music(s);
      const track = p.tracks.find((t) => t.kind === "audio" && t.role === "music" && !t.locked);
      if (!track) throw new Error("There's no unlocked music track.");
      return [{ kind: "place", mediaId, trackId: track.id, t: 0 }, applied(s)];
    }
    case "intro": {
      const intro = await deps.intro(s);
      if (!intro) throw new Error("Couldn't make the intro.");
      return [{ kind: "insertIntro", intro }, applied(s)];
    }
    default:
      throw new Error(`Unknown kind ${String(s.kind)}`);
  }
}

/** 依序套用勾選的項目；回傳要合成一筆送出的編輯，和失敗的項目 */
export async function applyScript(project: Project, items: Suggestion[], deps: ApplyDeps): Promise<ApplyResult> {
  const order = [...items].filter((s) => s.status === "pending").sort((a, b) => PHASE[a.kind] - PHASE[b.kind] || a.start - b.start);
  let p = project;
  const edits: Edit[] = [];
  const failed: ApplyResult["failed"] = [];
  for (const [i, s] of order.entries()) {
    try {
      const e = await editsFor(p, s, deps);
      p = applyEdits(p, e);
      edits.push(...e);
    } catch (err) {
      failed.push({ id: s.id, message: err instanceof Error ? err.message : String(err) });
    }
    deps.onProgress?.(i + 1, order.length, s);
  }
  return { edits, failed };
}
