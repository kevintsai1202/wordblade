// 素材庫的匯入流程（§5.13）：讀規格 → 加進專案（不進復原歷史）→ 背景準備（縮圖、音量包絡、Windows 版的代理檔）。
// 背景準備一次只跑一支（§5.21 重工作排隊）。包絡、縮圖、狀態是由素材算出來的，放在這裡，不放進專案。
import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import type { Envelope } from "../audio/envelope";
import type { Media } from "../core/model";
import { UnsupportedMediaError, type Engine, type ImportSource } from "../engine/Engine";
import type { Action } from "./state";
import { beginBusy } from "../core/busy";
import type { ThumbStore } from "../media/thumbStore";

/** 素材庫一筆的狀態 */
export interface LibraryItem {
  name: string;
  /** probing 讀規格中、preparing 背景準備中（預覽先用原檔）、ready 完成、failed 不能用 */
  status: "probing" | "preparing" | "ready" | "failed";
  /** 背景準備的進度 0～1 */
  progress: number;
  error?: string;
  thumbnailUrl?: string;
}

/** 素材庫：各素材的狀態與音量包絡 */
export interface Library {
  items: Map<string, LibraryItem>;
  envelopes: Map<string, Envelope>;
}

/** 新素材的 id */
function newMediaId(): string {
  return `m-${crypto.randomUUID().slice(0, 8)}`;
}

/** 素材庫與匯入；回傳目前的素材庫與匯入函式 */
export function useMediaLibrary(engine: Engine, dispatch: Dispatch<Action>, thumbs?: ThumbStore) {
  const [library, setLibrary] = useState<Library>({ items: new Map(), envelopes: new Map() });
  /** 背景準備的佇列：每支接在前一支後面 */
  const queue = useRef<Promise<void>>(Promise.resolve());

  /** 更新一筆的狀態 */
  const patch = useCallback((id: string, change: Partial<LibraryItem>) => {
    setLibrary((lib) => {
      const items = new Map(lib.items);
      const prev = items.get(id);
      items.set(id, { ...(prev ?? { name: id, status: "probing", progress: 0 }), ...change });
      return { ...lib, items };
    });
  }, []);

  /** 把素材排進背景準備（縮圖、包絡、代理檔）；代理檔路徑記進專案的素材（不進復原歷史） */
  const enqueuePrepare = useCallback(
    (media: Media) => {
      patch(media.id, { name: media.name ?? media.id, status: "preparing" });
      queue.current = queue.current.then(async () => {
        // 素材準備是重工作：期間背景縮圖排程停下來
        const endBusy = beginBusy();
        try {
          // 先做素材庫縮圖、包絡與代理檔（有進度），做完就標成就緒；
          // 時間軸的第一層縮圖（每 10 秒、寬 160，只解關鍵幀；D39）之後再補。長片的第一層要解上千格又沒有進度，
          // 以前放在前面會讓素材庫停在「Preparing 0%」好幾分鐘（2026-11-01，5 小時的片）
          const result = await engine.prepare(media, (progress) => patch(media.id, { progress }));
          if (result.proxyPath) dispatch({ type: "patchMedia", id: media.id, patch: { proxyPath: result.proxyPath } });
          setLibrary((lib) => {
            const items = new Map(lib.items);
            items.set(media.id, { ...items.get(media.id)!, status: "ready", progress: 1, thumbnailUrl: result.thumbnailUrl });
            const envelopes = new Map(lib.envelopes);
            if (result.envelope) envelopes.set(media.id, result.envelope);
            return { items, envelopes };
          });
          if (thumbs && media.kind === "video") {
            await thumbs.track(media);
            await thumbs.runTier(media.id, 0);
          }
        } catch (e) {
          // 準備失敗不影響使用：預覽繼續用原檔，只是沒有縮圖、波形或代理檔
          patch(media.id, { status: "failed", error: `Preparing failed: ${String(e)}` });
        } finally {
          endBusy();
        }
      });
    },
    [engine, dispatch, patch, thumbs],
  );

  /** 匯入一批檔案：逐一讀規格，讀得到的加進專案並排入背景準備；回傳成功匯入的素材（AI 音效要拿 id 放上時間軸） */
  const importSources = useCallback(
    async (sources: ImportSource[]): Promise<Media[]> => {
      const imported: Media[] = [];
      for (const source of sources) {
        const id = newMediaId();
        patch(id, { name: source.name, status: "probing", progress: 0 });
        let media;
        try {
          media = await engine.probe(source, id);
        } catch (e) {
          patch(id, { status: "failed", error: e instanceof UnsupportedMediaError ? e.message : `Can't import: ${String(e)}` });
          continue;
        }
        dispatch({ type: "importMedia", media: [media] });
        enqueuePrepare(media);
        imported.push(media);
      }
      return imported;
    },
    [engine, dispatch, patch, enqueuePrepare],
  );

  /** 換專案前清空素材庫：釋放縮圖與匯入檔案的 blob 網址（只在明確換專案時做，不在卸載時做：StrictMode 會重跑 effect） */
  const reset = useCallback(
    (oldMedia: Media[]) => {
      setLibrary((lib) => {
        for (const item of lib.items.values()) if (item.thumbnailUrl) URL.revokeObjectURL(item.thumbnailUrl);
        return { items: new Map(), envelopes: new Map() };
      });
      for (const m of oldMedia) engine.release(m);
    },
    [engine],
  );

  // 從檔案總管拖進視窗
  useEffect(() => engine.onFilesDropped((sources) => void importSources(sources)), [engine, importSources]);

  return { library, importSources, enqueuePrepare, reset };
}
