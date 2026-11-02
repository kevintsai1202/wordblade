// 遮罩的畫法（spec §5.3，D24：預覽與匯出共用）：影像圖層畫完後，對這支素材在這個素材時間有效的每個遮罩物件，
// 畫一張蓋住整個來源畫面的遮罩圖（SAM 點陣放到框的位置；解不開或沒有遮罩就用框的橢圓；外擴＝框寬的百分比，用模糊再取門檻做），
// 再交給合成器的 drawMasked 套效果。效果大小以 1080p 為準：馬賽克格子＝strength 像素、模糊 sigma＝strength 像素，依輸出高度縮放。
import type { GlCompositor, MaskEffect } from "../compositor/glCompositor";
import type { MaskObject, MaskSample, Project, Rect } from "../core/model";
import type { GradeValues } from "../core/colorGrade";
import { decodeMask } from "./decoder";
import { activeSample } from "./tracks";

/** 遮罩圖的寬度（高度依素材比例） */
const MASK_W = 640;
/** 解碼後點陣的快取上限 */
const MAX_RASTERS = 400;

/** 要畫的影像圖層（previewPlayer 與 exporter 的 layer） */
export interface MaskTarget {
  mediaId: string;
  srcTime: number;
  rect: Rect;
  opacity: number;
  crop?: Rect;
  /** 色彩調整（和影像圖層同一組，遮罩區才不會沒調色） */
  grade?: GradeValues;
}

/** 顏色字串 #rrggbb → 0～1 */
function rgb(hex: string | undefined): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex ?? "");
  const v = m ? parseInt(m[1], 16) : 0;
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

/** 遮罩圖層：解碼快取與每個物件的遮罩畫布（預覽與匯出各一個） */
export class MaskLayer {
  /** SAM 編碼內容 → 點陣畫布（白色＝遮罩；解不開是 null） */
  private rasters = new Map<string, OffscreenCanvas | null>();
  /** 畫遮罩圖用的畫布（每畫一個物件就重畫一次，交給 WebGL 後就能重用） */
  private canvas: OffscreenCanvas | null = null;

  /** 點陣畫布（LRU 快取） */
  private raster(m: NonNullable<MaskSample["mask"]>): OffscreenCanvas | null {
    const key = `${m.cols}x${m.rows}:${m.payload}`;
    if (this.rasters.has(key)) {
      const hit = this.rasters.get(key)!;
      this.rasters.delete(key);
      this.rasters.set(key, hit);
      return hit;
    }
    let out: OffscreenCanvas | null = null;
    try {
      const bits = decodeMask(m.payload, m.cols, m.rows);
      out = new OffscreenCanvas(m.cols, m.rows);
      const img = new ImageData(m.cols, m.rows);
      for (let i = 0; i < bits.length; i++) {
        if (!bits[i]) continue;
        img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = img.data[i * 4 + 3] = 255;
      }
      out.getContext("2d")!.putImageData(img, 0, 0);
    } catch {
      out = null; // 解不開：改用框的橢圓
    }
    this.rasters.set(key, out);
    while (this.rasters.size > MAX_RASTERS) this.rasters.delete(this.rasters.keys().next().value!);
    return out;
  }

  /** 一個物件在某個取樣的遮罩圖（整個來源畫面，mw × mh） */
  private maskImage(obj: MaskObject, s: MaskSample, mw: number, mh: number): OffscreenCanvas {
    if (!this.canvas || this.canvas.width !== mw || this.canvas.height !== mh) this.canvas = new OffscreenCanvas(mw, mh);
    const ctx = this.canvas.getContext("2d")!;
    ctx.filter = "none";
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, mw, mh);
    const [x1, y1, x2, y2] = s.box;
    /** 外擴（遮罩圖像素） */
    const grow = (obj.expand / 100) * (x2 - x1) * mw;
    const raster = s.mask ? this.raster(s.mask) : null;
    /** 畫一次遮罩形狀（blur 時往外暈開，shader 取門檻後就是外擴） */
    const paint = () => {
      if (raster && s.mask) {
        ctx.imageSmoothingEnabled = true;
        ctx.drawImage(raster, s.mask.x * mw, s.mask.y * mh, s.mask.w * mw, s.mask.h * mh);
      } else if (obj.shape === "rect") {
        ctx.fillStyle = "#fff";
        // 長方形（螢幕上的文字）：寬高各自外擴自己的百分比，再多 4 像素（框常常不太準）
        const gx = (obj.expand / 100) * (x2 - x1) * mw + 4;
        const gy = (obj.expand / 100) * (y2 - y1) * mh + 4;
        ctx.fillRect(x1 * mw - gx, y1 * mh - gy, (x2 - x1) * mw + gx * 2, (y2 - y1) * mh + gy * 2);
      } else {
        ctx.fillStyle = "#fff";
        ctx.beginPath();
        ctx.ellipse(((x1 + x2) / 2) * mw, ((y1 + y2) / 2) * mh, ((x2 - x1) / 2) * mw + grow, ((y2 - y1) / 2) * mh + grow, 0, 0, Math.PI * 2);
        ctx.fill();
      }
    };
    paint();
    if (raster && grow >= 1) {
      ctx.filter = `blur(${(grow / 2).toFixed(1)}px)`;
      paint();
      paint();
      ctx.filter = "none";
    }
    return this.canvas;
  }

  /**
   * 在剛畫好的影像圖層上套遮罩。source：那一格的影像（和圖層同一個）；outW／outH：輸出畫面大小（效果大小依它縮放）。
   * 回傳狀態字串（併進預覽的「下層畫面狀態」，遮罩改了讀下層畫面的 3D 場景才會重畫）。
   */
  draw(compositor: GlCompositor, project: Project, target: MaskTarget, source: TexImageSource, outW: number, outH: number): string {
    const masks = (project.masks ?? []).filter((m) => m.enabled && m.mediaId === target.mediaId);
    if (!masks.length) return "";
    const media = project.media.find((m) => m.id === target.mediaId);
    const mw = MASK_W;
    const mh = Math.max(2, Math.round(MASK_W * ((media?.height ?? 9) / (media?.width ?? 16))));
    const crop = target.crop ?? { x: 0, y: 0, w: 1, h: 1 };
    /** 輸出 1 像素 = 來源貼圖座標多少 */
    const px = [crop.w / (target.rect.w * outW), crop.h / (target.rect.h * outH)];
    const scale = outH / 1080;
    let state = "";
    for (const obj of masks) {
      const s = activeSample(obj, target.srcTime);
      if (!s) continue;
      const strength = Math.max(2, obj.effect.strength * scale);
      const effect: MaskEffect = {
        mode: obj.effect.kind,
        block: [strength * px[0], strength * px[1]],
        radius: [strength * px[0], strength * px[1]],
        solid: rgb(obj.effect.color),
      };
      compositor.drawMasked(source, target.rect, target.opacity, crop, this.maskImage(obj, s, mw, mh), effect, target.grade);
      state += `|m:${obj.id}@${s.t}:${obj.effect.kind}${obj.effect.strength}${obj.expand}`;
    }
    return state;
  }
}
