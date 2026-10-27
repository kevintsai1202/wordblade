// 「用說的」（spec §5.8）：一句話 → 閘道請 Muse Spark 回板子的關鍵幀與設定（不是程式碼）→ 用原專案的姿勢數學檢查
// （關鍵幀時間遞增、姿勢路徑可用）→ 不過就回饋（最多 2 輪）→ 回傳提議，介面先預覽、按套用才寫進專案。
import { PLANE3D } from "../three/plane3d";
import { GatewayClient, type VibeError } from "./gateway";

/** 板子的設定（floating-board 的參數） */
export type BoardParams = Record<string, unknown> & { keys?: unknown[]; edges?: boolean; float?: unknown };

/** 拒答與失敗代碼 → 給使用者看的固定文字 */
export const PLANE3D_MESSAGES: Record<string, string> = {
  "off-topic": "That isn't about how the board moves. Describe the motion or the background.",
  "too-complex": "That needs too many keyframes. Try a simpler move.",
  "invalid-response": "The AI couldn't produce a valid camera move. Try rephrasing.",
  budget: "The AI couldn't produce a valid camera move. Try rephrasing.",
  "model-error": "The AI service didn't respond. Try again in a moment.",
  rounds: "The AI's camera move still wasn't valid after 2 tries. Try rephrasing.",
};

/** 合併提議與目前設定（模型沒回的欄位維持原值），檢查時間與路徑；回傳錯誤（空＝可以用） */
export function checkProposal(current: BoardParams, proposal: BoardParams, length: number, width: number, height: number): { merged: BoardParams; errors: VibeError[] } {
  const merged: BoardParams = { ...current, ...proposal };
  const errors: VibeError[] = [];
  const effect = { keys: merged.keys ?? [], edges: merged.edges !== false, float: merged.float ?? null };
  try {
    PLANE3D.keyTimes(effect, length);
  } catch {
    errors.push({ stage: "schema", component: null, message: "keys 換算成時間後要嚴格遞增", line: null, column: null });
  }
  if (!PLANE3D.pathValid(effect.keys, effect.float, width, height)) {
    errors.push({ stage: "schema", component: null, message: "有些姿勢讓板子太靠近鏡頭、跑出畫面太遠或翻面了；請把轉角或位移改小、size 改大一點", line: null, column: null });
  }
  return { merged, errors };
}

/** 跑一次「用說的」；成功回傳合併後的設定，失敗回傳訊息 */
export async function runPlane3d(gateway: GatewayClient, input: { description: string; screenshot: string | null; current: BoardParams; length: number; width: number; height: number }): Promise<{ ok: true; params: BoardParams } | { ok: false; message: string }> {
  const jobId = await gateway.startPlane3d({ ...input });
  for (;;) {
    const view = await gateway.waitPlane3d(jobId);
    if (view.status === "failed") return { ok: false, message: PLANE3D_MESSAGES[view.error ?? "invalid-response"] ?? PLANE3D_MESSAGES["invalid-response"] };
    const result = view.result!;
    if (result.refusal) return { ok: false, message: PLANE3D_MESSAGES[result.refusal] ?? PLANE3D_MESSAGES["off-topic"] };
    const { merged, errors } = checkProposal(input.current, result.proposal ?? {}, input.length, input.width, input.height);
    if (!errors.length) return { ok: true, params: merged };
    if (view.round >= 2) return { ok: false, message: PLANE3D_MESSAGES.rounds };
    await gateway.feedbackPlane3d(jobId, errors);
  }
}
