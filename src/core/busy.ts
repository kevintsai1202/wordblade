// 重工作登記（§5.21：重工作不同時跑）：素材準備、匯出、轉錄開始時 beginBusy、結束時呼叫回傳的函式。
// 背景的縮圖排程只在沒有重工作、也沒在播放時才做（D39）。

/** 進行中的重工作數 */
let count = 0;

/** 開始一件重工作；回傳結束函式（重複呼叫只算一次） */
export function beginBusy(): () => void {
  count++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    count--;
  };
}

/** 現在有沒有重工作在跑 */
export function isBusy(): boolean {
  return count > 0;
}
