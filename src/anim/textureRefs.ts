// 3D 特效參數裡的「材質引用」（spec §5.12，P1-14）：Inspector 的 texture 參數存成
//   { textureId, color: <素材 id>, normal?: <素材 id>, repeat?, normalStrength? }
// 這裡是純函式：①掃出特效參數裡的引用、把用到的圖接在 imageIds 後面並算出 __textures（送進 3D 沙盒）；
// ②材質庫改了（再產生、調法線強度、刪除）時改寫特效參數裡的引用。

/** 材質引用 */
export interface TextureRef {
  /** 材質庫的項目 id（TextureAsset.id） */
  textureId: string;
  /** 顏色圖的素材 id */
  color: string;
  /** 法線圖的素材 id */
  normal?: string;
  /** 平鋪倍數（插件拿來乘上各表面的基本平鋪次數） */
  repeat?: number;
  /** 法線強度（插件用 normalScale 套） */
  normalStrength?: number;
}

/** 送進沙盒的材質描述（map／normal 是圖片陣列 env.images 的索引） */
export interface SandboxTexture {
  map: number;
  normal: number | null;
  repeat: number;
  normalStrength: number;
}

/** 是不是材質引用 */
export function isTextureRef(v: unknown): v is TextureRef {
  return !!v && typeof v === "object" && typeof (v as TextureRef).textureId === "string" && typeof (v as TextureRef).color === "string";
}

/**
 * 掃 3D 特效的參數（Effect.params.params 那一層），把材質引用用到的圖接在 imageIds 後面。
 * 回傳完整的圖片 id 清單（imageIds 在前，引用的依序在後，重複的共用同一格）與 __textures（沒有引用就是 null）。
 */
export function resolveTextureRefs(params: Record<string, unknown>, imageIds: string[]): { ids: string[]; textures: Record<string, SandboxTexture> | null } {
  const ids = [...imageIds];
  /** 圖在清單裡的索引（沒有就接在最後） */
  const indexOf = (id: string) => {
    const at = ids.indexOf(id);
    if (at >= 0) return at;
    ids.push(id);
    return ids.length - 1;
  };
  const textures: Record<string, SandboxTexture> = {};
  for (const [name, value] of Object.entries(params)) {
    if (!isTextureRef(value)) continue;
    textures[name] = {
      map: indexOf(value.color),
      normal: value.normal ? indexOf(value.normal) : null,
      repeat: typeof value.repeat === "number" && value.repeat > 0 ? value.repeat : 1,
      normalStrength: typeof value.normalStrength === "number" ? value.normalStrength : 1,
    };
  }
  return { ids, textures: Object.keys(textures).length ? textures : null };
}

/**
 * 改寫特效參數（整個 Effect.params，3D 的值在 .params 那一層）裡指向某個材質的引用。
 * change 回傳新的引用，或 null 表示拿掉（回到預設）；沒有任何引用被改到就回傳原物件。
 */
export function rewriteTextureRefs(effectParams: Record<string, unknown>, textureId: string, change: (ref: TextureRef) => TextureRef | null): Record<string, unknown> {
  const inner = effectParams.params;
  if (!inner || typeof inner !== "object") return effectParams;
  let changed = false;
  const next: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(inner as Record<string, unknown>)) {
    if (isTextureRef(value) && value.textureId === textureId) {
      changed = true;
      next[name] = change(value);
    } else next[name] = value;
  }
  return changed ? { ...effectParams, params: next } : effectParams;
}
