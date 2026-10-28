// 3D 插件要的圖片（env.images；一鍵片頭的封面與 icon）：依素材 id 解碼成 ImageBitmap，寬度縮到 ≤ 1280
// （軟體算繪第一格要一次上傳十幾張貼圖，太大會逾時）。同一支素材只解一次；預覽與匯出各建一個。
import type { Media } from "../core/model";
import type { ImageSource } from "./effectRenderer";

/** 圖片最寬幾像素 */
export const EFFECT_IMAGE_MAX_WIDTH = 1280;

/**
 * 建圖片來源。
 * @param mediaUrl 素材的網址（Engine.mediaUrl）
 * @param findMedia 依 id 找素材（找目前專案）
 */
export function createImageSource(mediaUrl: (media: Media) => string, findMedia: (id: string) => Media | undefined): ImageSource & { dispose(): void } {
  /** 素材 id → 解碼中或解好的圖 */
  const cache = new Map<string, Promise<ImageBitmap>>();

  /** 解一張；讀不到（素材不見、不是圖）回 1×1 灰格，插件照樣畫得下去 */
  const decode = async (id: string): Promise<ImageBitmap> => {
    const media = findMedia(id);
    try {
      if (!media || media.kind !== "image") throw new Error("not an image");
      const blob = await (await fetch(mediaUrl(media))).blob();
      const full = await createImageBitmap(blob);
      if (full.width <= EFFECT_IMAGE_MAX_WIDTH) return full;
      const scaled = await createImageBitmap(full, { resizeWidth: EFFECT_IMAGE_MAX_WIDTH, resizeHeight: Math.round((full.height * EFFECT_IMAGE_MAX_WIDTH) / full.width), resizeQuality: "high" });
      full.close();
      return scaled;
    } catch {
      return createImageBitmap(new ImageData(new Uint8ClampedArray([128, 128, 128, 255]), 1, 1));
    }
  };

  const source = (ids: string[]) => Promise.all(ids.map((id) => {
    let p = cache.get(id);
    if (!p) {
      p = decode(id);
      cache.set(id, p);
    }
    return p;
  }));
  return Object.assign(source, {
    dispose() {
      for (const p of cache.values()) void p.then((b) => b.close());
      cache.clear();
    },
  });
}
