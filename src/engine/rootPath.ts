// 網頁版授權資料夾的路徑換算（2026-11-01）：瀏覽器拿不到檔案的完整路徑，只拿得到使用者授權的資料夾 handle（只有資料夾名）。
// 桌面版存的素材路徑（例如 D:\GitHub\yt\a.mp4）在授權的 GitHub 資料夾裡要走哪幾層，靠路徑裡和資料夾同名的那一層來對。

/** 路徑拆成各層（\ 與 / 都算） */
function segments(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/** path 在名為 rootName 的資料夾底下的各層（不分大小寫，取最後一個同名的那一層）；路徑裡沒有那一層回 null */
export function pathUnderRoot(path: string, rootName: string): string[] | null {
  const segs = segments(path);
  const key = rootName.toLowerCase();
  for (let i = segs.length - 2; i >= 0; i--) if (segs[i].toLowerCase() === key) return segs.slice(i + 1);
  return null;
}

/** 幾個檔案路徑共同的上層資料夾（提示使用者授權哪裡）；不同磁碟機或沒有回 null */
export function commonFolder(paths: string[]): string | null {
  if (!paths.length) return null;
  const sep = paths[0].includes("\\") ? "\\" : "/";
  const dirs = paths.map((p) => segments(p).slice(0, -1));
  const first = dirs[0];
  let n = 0;
  while (n < first.length && dirs.every((d) => d[n]?.toLowerCase() === first[n].toLowerCase())) n++;
  if (n === 0) return null;
  const head = paths[0].startsWith(sep) ? sep : "";
  return head + first.slice(0, n).join(sep);
}
