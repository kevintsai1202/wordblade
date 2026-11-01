// 網頁版的檔案權限（spec §5.21、D41）：File System Access 的 handle 存在 IndexedDB，重新整理或下次開瀏覽器還拿得到。
// 存的是專案資料夾（鍵＝ProjectLocation.dir）與匯入的素材檔（鍵＝Media.handleKey）。handle 本身可以結構化複製，直接存。
// 權限不跟著 handle 存：拿出來要再 queryPermission／requestPermission（後者要使用者手勢）。

/** 資料庫名稱與 object store */
const DB = "wordblade-handles";
const STORE = "handles";

/** File System Access 裡 DOM 型別還沒有的部分 */
export interface PermissionHandle {
  queryPermission(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission(opts: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

/** 開資料庫（第一次建 object store） */
function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 在一個交易裡做一件事 */
async function run<T>(mode: IDBTransactionMode, fn: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

/** 存 handle */
export function putHandle(key: string, handle: FileSystemHandle): Promise<void> {
  return run("readwrite", (s) => s.put(handle, key)).then(() => undefined);
}

/** 取 handle；沒有回 undefined */
export function getHandle<T extends FileSystemHandle>(key: string): Promise<T | undefined> {
  return run("readonly", (s) => s.get(key) as IDBRequest<T | undefined>);
}

/**
 * 確認有權限：已經允許就回 true；還沒問過就請求（要在使用者手勢裡呼叫才會跳詢問）；被拒或沒有手勢回 false。
 */
export async function ensurePermission(handle: FileSystemHandle, mode: "read" | "readwrite"): Promise<boolean> {
  const h = handle as unknown as PermissionHandle;
  if (typeof h.queryPermission !== "function") return true;
  if ((await h.queryPermission({ mode })) === "granted") return true;
  try {
    return (await h.requestPermission({ mode })) === "granted";
  } catch {
    return false;
  }
}
