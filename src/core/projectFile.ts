// 專案資料夾的 project.json（spec §5.13、D41）：專案內容＋每支素材的參照（絕對路徑、相對專案資料夾的路徑、內容指紋）。
// 素材不複製進專案；搬家或換電腦後依「相對路徑 → 原本的絕對路徑 → 指紋比對」找回來，都找不到才請使用者重新連結。純函式。
import type { MaskObject, Project } from "./model";

/** 格式名稱與版本 */
const FORMAT = "wordblade-project";
/** 第 2 版：遮罩取樣移到 .data\masks\（舊版程式讀不到，所以升版讓它拒絕而不是悄悄丟掉遮罩） */
const VERSION = 2;

/** 一支素材的參照 */
export interface MediaRef {
  /** 存檔時的絕對路徑（網頁版的素材沒有） */
  path?: string;
  /** 相對專案資料夾的路徑（一律用 /；不同磁碟機時沒有） */
  rel?: string;
  /** 內容指紋（大小＋頭尾各 1 MB 的 SHA-256） */
  fingerprint?: string;
}

/** 路徑拆成磁碟機（或根）與各段；分隔符號 \ 和 / 都接受 */
function split(path: string): { root: string; parts: string[] } {
  const norm = path.replace(/\\/g, "/");
  const m = /^([a-zA-Z]:)?\//.exec(norm);
  const root = m ? (m[1] ?? "").toLowerCase() + "/" : "";
  return { root, parts: norm.slice(m ? m[0].length : 0).split("/").filter(Boolean) };
}

/** 從資料夾 dir 到檔案 file 的相對路徑（用 /）；不同磁碟機回 null。Windows 路徑不分大小寫 */
export function relativePath(dir: string, file: string): string | null {
  const a = split(dir);
  const b = split(file);
  if (a.root !== b.root) return null;
  const windows = /^[a-z]:\//.test(a.root);
  const same = (x: string, y: string) => (windows ? x.toLowerCase() === y.toLowerCase() : x === y);
  let i = 0;
  while (i < a.parts.length && i < b.parts.length - 1 && same(a.parts[i], b.parts[i])) i++;
  return [...Array(a.parts.length - i).fill(".."), ...b.parts.slice(i)].join("/");
}

/** 資料夾＋相對路徑 → 絕對路徑（照資料夾用的分隔符號） */
export function joinPath(dir: string, rel: string): string {
  const sep = dir.includes("\\") ? "\\" : "/";
  const { root, parts } = split(dir);
  const out = [...parts];
  for (const seg of rel.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  const head = /^[a-z]:\/$/.test(root) ? dir.slice(0, 2) + sep : root ? sep : "";
  return head + out.join(sep);
}

/** 專案 → project.json 的文字；projectDir 是專案資料夾（算相對路徑用），fingerprints 是各素材的內容指紋 */
export function toProjectFile(project: Project, opts: { projectDir: string; savedAt: number; fingerprints?: Record<string, string> }): string {
  const media: Record<string, MediaRef> = {};
  for (const m of project.media) {
    const ref: MediaRef = {};
    if (m.path) {
      ref.path = m.path;
      const rel = relativePath(opts.projectDir, m.path);
      if (rel !== null) ref.rel = rel;
    }
    const fp = opts.fingerprints?.[m.id];
    if (fp) ref.fingerprint = fp;
    media[m.id] = ref;
  }
  return JSON.stringify({ format: FORMAT, v: VERSION, savedAt: opts.savedAt, media, project }, null, 1);
}

/** project.json 的文字 → 專案、各素材的參照、存檔時間；格式或版本不對回 null */
export function fromProjectFile(text: string): { project: Project; refs: Record<string, MediaRef>; savedAt: number } | null {
  try {
    const data = JSON.parse(text) as { format?: string; v?: number; savedAt?: number; media?: Record<string, MediaRef>; project?: Project };
    const p = data.project;
    if (data.format !== FORMAT || typeof data.v !== "number" || data.v > VERSION || !p || !Array.isArray(p.media) || !Array.isArray(p.clips)) return null;
    return { project: p, refs: data.media ?? {}, savedAt: Number(data.savedAt) || 0 };
  } catch {
    return null;
  }
}

/** 找素材的順序：相對路徑（照現在的專案位置）→ 原本的絕對路徑；重複的只留一個（之後再用指紋確認是同一支） */
export function relinkCandidates(ref: MediaRef | undefined, projectDir: string): string[] {
  if (!ref) return [];
  const list: string[] = [];
  if (ref.rel) list.push(joinPath(projectDir, ref.rel));
  if (ref.path) list.push(ref.path);
  const seen = new Set<string>();
  return list.filter((p) => {
    const k = p.replace(/\\/g, "/").toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * 開專案時找回素材：每支素材依 relinkCandidates 的順序交給 locate（平台：檢查存在與指紋）；
 * 找到的換成新路徑，找不到的留在專案裡、列為遺失（介面請使用者重新連結）。
 */
export async function relinkProject(
  project: Project,
  refs: Record<string, MediaRef>,
  projectDir: string,
  locate: (media: Project["media"][number], candidates: string[], fingerprint?: string) => Promise<Project["media"][number] | null>,
): Promise<{ project: Project; missing: string[] }> {
  const missing: string[] = [];
  const media = await Promise.all(project.media.map(async (m) => {
    const ref = refs[m.id];
    const found = await locate(m, relinkCandidates(ref ?? { path: m.path }, projectDir), ref?.fingerprint);
    if (found) return found;
    missing.push(m.id);
    return m;
  }));
  return { project: { ...project, media }, missing: project.media.map((m) => m.id).filter((id) => missing.includes(id)) };
}


/**
 * 遮罩取樣拆到 .data\masks\<id>.json（D41 P5）：回傳取樣清空、記上參照的專案，與要寫的檔案（相對 .data 的路徑 → 內容）。
 * id 只留英數、-、_，檔名跳不出 .data。原本的專案不改。
 */
export function externalizeMasks(project: Project): { project: Project; files: Record<string, string> } {
  const files: Record<string, string> = {};
  const masks = project.masks.map((m) => {
    if (!m.samples.length) return m;
    const rel = `masks/${m.id.replace(/[^A-Za-z0-9_-]/g, "-")}.json`;
    files[rel] = JSON.stringify(m.samples);
    return { ...m, samples: [], samplesRef: rel };
  });
  return { project: { ...project, masks }, files };
}

/** 讀回遮罩取樣：有參照的照參照讀檔（read 回 null＝讀不到，取樣留空）；沒有參照的（舊專案）照舊 */
export async function internalizeMasks(project: Project, read: (rel: string) => Promise<string | null>): Promise<Project> {
  const masks = await Promise.all(project.masks.map(async (m) => {
    if (!m.samplesRef) return m;
    const { samplesRef, ...rest } = m;
    let samples: MaskObject["samples"] = [];
    try {
      const text = await read(samplesRef);
      if (text) samples = JSON.parse(text);
    } catch {
      /* 壞掉的取樣檔：留空（遮罩退回不顯示），不擋開專案 */
    }
    return { ...rest, samples };
  }));
  return { ...project, masks };
}
