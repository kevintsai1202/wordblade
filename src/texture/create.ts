// 產生一張材質或 3D 背景（spec §5.12，P1-14）：閘道 Muse Image → 本機後處理 → 存成素材 → 材質庫項目。
// Textures 頁籤（手動）與 Vibe 3D（插件宣告的材質參數，2026-11-01）共用。
import type { GatewayClient } from "../ai/gateway";
import type { TextureAsset } from "../core/model";
import { buildBackground, buildTexture } from "./build";

/** 檔名用的短字：只留英數，最多 24 字 */
export function textureSlug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "tex";
}

/**
 * 產生圖片、後處理、存進素材庫，回傳材質庫的項目（還沒提交；呼叫端決定和哪些編輯一起提交）。
 * saveImage：PNG 存進素材庫（role="texture"），回傳素材 id。again：再產生（沿用 id、名字、強度、平鋪）。
 */
export async function createTextureAsset(
  gateway: GatewayClient,
  kind: TextureAsset["kind"],
  prompt: string,
  saveImage: (name: string, bytes: Uint8Array) => Promise<string>,
  onStage: (stage: "generating" | "processing") => void = () => undefined,
  again?: TextureAsset,
): Promise<TextureAsset> {
  onStage("generating");
  const blob = await gateway.generateImage(kind, prompt);
  onStage("processing");
  const stem = `tex-${textureSlug(prompt)}-${crypto.randomUUID().slice(0, 6)}`;
  let colorMediaId: string;
  let normalMediaId: string | undefined;
  if (kind === "texture") {
    const built = await buildTexture(blob);
    colorMediaId = await saveImage(`${stem}.png`, built.color);
    normalMediaId = await saveImage(`${stem}-n.png`, built.normal);
  } else {
    colorMediaId = await saveImage(`${stem}.png`, await buildBackground(blob));
  }
  return again
    ? { ...again, colorMediaId, normalMediaId }
    : { id: `tex-${crypto.randomUUID().slice(0, 8)}`, kind, name: prompt.length > 40 ? `${prompt.slice(0, 39)}…` : prompt, prompt, colorMediaId, ...(normalMediaId ? { normalMediaId } : {}), normalStrength: 1, repeat: 1 };
}
