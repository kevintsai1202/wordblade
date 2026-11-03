// 素材的內容指紋（D41）：大小＋頭尾各 1 MB 的 FNV-1a 64，格式「大小:16 位十六進位」。
// 和 Rust src-tauri/src/project.rs 的 fingerprint 逐位元組相同：網頁版存的專案在桌面版開（或反過來）時，用它確認找到的是同一支檔案。

/** 頭尾各取幾位元組 */
export const FP_CHUNK = 1 << 20;

const OFFSET = 0xcbf29ce484222325n;
const PRIME = 0x100000001b3n;
const MASK = 0xffffffffffffffffn;

/** FNV-1a 64 接著算一段 */
function fnv1a(h: bigint, bytes: Uint8Array): bigint {
  for (const b of bytes) h = ((h ^ BigInt(b)) * PRIME) & MASK;
  return h;
}

/** 指紋：head 是開頭 min(FP_CHUNK, size) 位元組；size > FP_CHUNK 時 tail 是結尾 min(FP_CHUNK, size − FP_CHUNK) 位元組 */
export function fingerprintBytes(head: Uint8Array, size: number, tail?: Uint8Array): string {
  let h = fnv1a(OFFSET, head);
  if (tail && size > FP_CHUNK) h = fnv1a(h, tail);
  return `${size}:${h.toString(16).padStart(16, "0")}`;
}

/** 檔案（Blob）的指紋 */
export async function fingerprintFile(file: Blob): Promise<string> {
  const size = file.size;
  const head = new Uint8Array(await file.slice(0, Math.min(FP_CHUNK, size)).arrayBuffer());
  const tail = size > FP_CHUNK ? new Uint8Array(await file.slice(size - Math.min(FP_CHUNK, size - FP_CHUNK)).arrayBuffer()) : undefined;
  return fingerprintBytes(head, size, tail);
}
