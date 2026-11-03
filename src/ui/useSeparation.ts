// 聲音分離的執行流程（§5.14、P1-10）：呼叫 Engine 分離 → 兩個 WAV 走一般匯入 → 一次可復原的編輯把時間軸上的音訊片段換成人聲＋背景。
// 進度與錯誤放在這裡（不放在素材頁籤元件裡）：切到別的頁籤再回來，進度仍在。
import { useCallback, useRef, useState, type Dispatch } from "react";
import { beginBusy } from "../core/busy";
import type { Media } from "../core/model";
import { SeparationCancelled, type Engine, type ImportSource, type SeparationProgress } from "../engine/Engine";
import type { Action } from "./state";

/** 一支素材的分離狀態：進行中（階段與比例）或失敗（錯誤文字） */
export type SeparationJob = ({ running: true } & SeparationProgress) | { running: false; error: string };

/** 進度的顯示文字，例如「Downloading model 12%」「Separating 34%」 */
export function separationLabel(p: SeparationProgress): string {
  return `${p.stage === "download" ? "Downloading model" : "Separating"} ${Math.round(p.ratio * 100)}%`;
}

/** 檔名去掉副檔名（衍生素材取名用） */
function stemName(name: string): string {
  return name.replace(/\.[^.\/\\]+$/, "");
}

/** 把引擎回傳的來源換成素材庫裡好讀的名字，例如 "talk (vocals).wav" */
function named(source: ImportSource, label: string, base: string): ImportSource {
  return { ...source, name: `${base} (${label}).wav` };
}

/** 聲音分離：回傳各素材的狀態與開始、取消函式；importSources 是素材庫的匯入函式 */
export function useSeparation(engine: Engine, importSources: (sources: ImportSource[]) => Promise<Media[]>, dispatch: Dispatch<Action>) {
  const [jobs, setJobs] = useState<Record<string, SeparationJob>>({});
  /** 進行中的素材 id（避免同一支重複按） */
  const running = useRef(new Set<string>());

  /** 更新一支素材的狀態；null＝清除 */
  const setJob = useCallback((id: string, job: SeparationJob | null) => {
    setJobs((j) => {
      const next = { ...j };
      if (job) next[id] = job;
      else delete next[id];
      return next;
    });
  }, []);

  /** 開始分離：成功後匯入兩個 WAV、記下 stems、替換時間軸上的片段（一次提交，一次 Ctrl+Z 復原） */
  const start = useCallback(
    async (media: Media) => {
      if (running.current.has(media.id)) return;
      running.current.add(media.id);
      setJob(media.id, { running: true, stage: "separate", ratio: 0 });
      // 分離是重工作：期間背景縮圖排程停下來
      const endBusy = beginBusy();
      try {
        const result = await engine.separateVocals(media, (p) => setJob(media.id, { running: true, ...p }));
        const base = stemName(media.name ?? media.id);
        const [vocals, background] = await importSources([named(result.vocals, "vocals", base), named(result.background, "music", base)]);
        if (!vocals || !background) throw new Error("Couldn't add the separated audio to the media library.");
        dispatch({ type: "commit", edits: [{ kind: "separateStems", mediaId: media.id, vocalsId: vocals.id, backgroundId: background.id }] });
        setJob(media.id, null);
      } catch (e) {
        setJob(media.id, e instanceof SeparationCancelled ? null : { running: false, error: `Separation failed: ${e instanceof Error ? e.message : String(e)}` });
      } finally {
        endBusy();
        running.current.delete(media.id);
      }
    },
    [engine, importSources, dispatch, setJob],
  );

  /** 取消進行中的分離 */
  const cancel = useCallback((mediaId: string) => void engine.cancelSeparation(mediaId), [engine]);

  /** 清掉失敗訊息 */
  const dismiss = useCallback((mediaId: string) => setJob(mediaId, null), [setJob]);

  return { jobs, start, cancel, dismiss };
}
