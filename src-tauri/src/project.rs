// 專案資料夾（spec §5.13、D41）：<專案名>.wordblade\ 裡看得到的只有 project.json，程式管理的資料放隱藏的 .data\。
// 寫 project.json 用「同資料夾暫存檔＋改名」，Windows 上目的檔剛好被讀取時改名會失敗，短暫重試（字導字演 core.write_json 的教訓）。
// 素材用路徑參照：內容指紋＝大小＋頭尾各 1 MB 的 FNV-1a，搬家後用它確認找到的是同一支檔案。

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager};

/// 專案資料夾的副檔名
const SUFFIX: &str = ".wordblade";
/// 專案檔名
const PROJECT_FILE: &str = "project.json";
/// 程式管理的資料（隱藏）
const DATA_DIR: &str = ".data";
/// 指紋取頭尾各幾位元組
const FP_CHUNK: u64 = 1 << 20;

/// FNV-1a 64（和網頁版 src/core/fingerprint.ts 同一個算法）
fn fnv1a(mut h: u64, bytes: &[u8]) -> u64 {
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// 檔案的內容指紋：「大小:頭尾各 1 MB 的 FNV-1a（十六進位）」
pub fn fingerprint(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let size = f.metadata().map_err(|e| e.to_string())?.len();
    let mut h = 0xcbf2_9ce4_8422_2325u64;
    let mut buf = vec![0u8; FP_CHUNK.min(size) as usize];
    f.read_exact(&mut buf).map_err(|e| e.to_string())?;
    h = fnv1a(h, &buf);
    if size > FP_CHUNK {
        let tail = FP_CHUNK.min(size - FP_CHUNK);
        f.seek(SeekFrom::Start(size - tail)).map_err(|e| e.to_string())?;
        let mut buf = vec![0u8; tail as usize];
        f.read_exact(&mut buf).map_err(|e| e.to_string())?;
        h = fnv1a(h, &buf);
    }
    Ok(format!("{size}:{h:016x}"))
}

/// 寫檔：同資料夾暫存檔＋改名；改名失敗（Windows 上目的檔正被讀）重試 5 次、每次 50 毫秒，放棄時刪掉暫存檔
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let tmp = path.with_extension(format!("json.{}.tmp", std::process::id()));
    fs::write(&tmp, text).map_err(|e| format!("無法寫入 {}：{e}", tmp.display()))?;
    for attempt in 0..5 {
        match fs::rename(&tmp, path) {
            Ok(()) => return Ok(()),
            Err(e) if attempt < 4 && e.kind() == std::io::ErrorKind::PermissionDenied => std::thread::sleep(std::time::Duration::from_millis(50)),
            Err(e) => {
                let _ = fs::remove_file(&tmp);
                return Err(format!("無法寫入 {}：{e}", path.display()));
            }
        }
    }
    Ok(())
}

/// 專案名稱 → 安全的資料夾名（去掉 Windows 不允許的字元與結尾的點、空白）
fn safe_name(name: &str) -> String {
    let cleaned: String = name.chars().map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '-' } else { c }).collect();
    let trimmed = cleaned.trim().trim_end_matches(['.', ' ']).to_string();
    if trimmed.is_empty() { "Untitled".into() } else { trimmed.chars().take(80).collect() }
}

/// .data 設成隱藏（Windows 用 attrib；失敗不影響使用）
fn hide(path: &Path) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = std::process::Command::new("attrib").arg("+h").arg(path).creation_flags(0x0800_0000).status();
    }
    #[cfg(not(windows))]
    let _ = path;
}

/// 在 parent 底下建專案資料夾 <name>.wordblade\（含隱藏的 .data\），回傳資料夾路徑；已經有 project.json 就不覆蓋、回錯誤
#[tauri::command]
pub fn project_create(app: AppHandle, parent: String, name: String) -> Result<String, String> {
    let dir = PathBuf::from(&parent).join(format!("{}{SUFFIX}", safe_name(&name)));
    if dir.join(PROJECT_FILE).exists() {
        return Err(format!("{} already has a project", dir.display()));
    }
    let data = dir.join(DATA_DIR);
    fs::create_dir_all(&data).map_err(|e| e.to_string())?;
    hide(&data);
    let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    Ok(dir.to_string_lossy().to_string())
}

/// 寫 project.json
#[tauri::command]
pub fn project_write(dir: String, text: String) -> Result<(), String> {
    write_atomic(&PathBuf::from(dir).join(PROJECT_FILE), &text)
}

/// 讀 project.json（dir 也可以直接給 project.json 的路徑）；回傳 [專案資料夾, 內容]
#[tauri::command]
pub fn project_read(app: AppHandle, dir: String) -> Result<(String, String), String> {
    let p = PathBuf::from(&dir);
    let folder = if p.file_name().is_some_and(|n| n == PROJECT_FILE) { p.parent().map(Path::to_path_buf).unwrap_or(p.clone()) } else { p };
    let text = fs::read_to_string(folder.join(PROJECT_FILE)).map_err(|e| format!("無法讀取 {}：{e}", folder.display()))?;
    let _ = app.asset_protocol_scope().allow_directory(&folder, true);
    Ok((folder.to_string_lossy().to_string(), text))
}

/// .data 裡的相對路徑 → 絕對路徑；只允許英數、-、_、. 組成的段落（不能有 ..、絕對路徑），跳不出 .data
pub fn data_path(dir: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut out = dir.join(DATA_DIR);
    let mut any = false;
    for seg in rel.split('/') {
        let ok = !seg.is_empty() && seg != "." && seg != ".." && seg.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
        if !ok {
            return Err(format!("bad data path: {rel}"));
        }
        out.push(seg);
        any = true;
    }
    if any { Ok(out) } else { Err("empty data path".into()) }
}

/// 寫 .data 裡的文字檔（遮罩取樣等；暫存檔＋改名）
#[tauri::command]
pub fn project_data_write(dir: String, rel: String, text: String) -> Result<(), String> {
    let path = data_path(Path::new(&dir), &rel)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    write_atomic(&path, &text)
}

/// 讀 .data 裡的文字檔；沒有回 None
#[tauri::command]
pub fn project_data_read(dir: String, rel: String) -> Result<Option<String>, String> {
    let path = data_path(Path::new(&dir), &rel)?;
    match fs::read_to_string(&path) {
        Ok(t) => Ok(Some(t)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// 素材的內容指紋
#[tauri::command]
pub async fn media_fingerprint(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || fingerprint(Path::new(&path))).await.map_err(|e| e.to_string())?
}

/// 依序找素材：第一個存在、而且（有記指紋時）指紋相同的路徑，放行給 asset 協定後回傳；都不是回 None
#[tauri::command]
pub async fn media_locate(app: AppHandle, candidates: Vec<String>, fingerprint: Option<String>) -> Result<Option<String>, String> {
    let found = tauri::async_runtime::spawn_blocking(move || {
        candidates.into_iter().find(|c| {
            let p = Path::new(c);
            p.is_file() && fingerprint.as_ref().is_none_or(|fp| self::fingerprint(p).ok().as_ref() == Some(fp))
        })
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Some(p) = &found {
        app.asset_protocol_scope().allow_file(p).map_err(|e| e.to_string())?;
    }
    Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_路徑_跳不出_data() {
        let dir = Path::new("D:\\p\\T.wordblade");
        assert_eq!(data_path(dir, "masks/k1.json").unwrap(), dir.join(".data").join("masks").join("k1.json"));
        assert!(data_path(dir, "../project.json").is_err());
        assert!(data_path(dir, "masks/../../x").is_err());
        assert!(data_path(dir, "C:\\x").is_err());
        assert!(data_path(dir, "").is_err());
    }

    #[test]
    fn 原子寫入_覆蓋舊內容_不留暫存檔() {
        let dir = std::env::temp_dir().join(format!("wb-project-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join(PROJECT_FILE);
        write_atomic(&file, "{\"a\":1}").unwrap();
        write_atomic(&file, "{\"a\":2}").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "{\"a\":2}");
        let leftovers = fs::read_dir(&dir).unwrap().filter(|e| e.as_ref().unwrap().file_name().to_string_lossy().ends_with(".tmp")).count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 指紋_大小加頭尾_內容不同就不同() {
        let dir = std::env::temp_dir().join(format!("wb-fp-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.bin");
        let b = dir.join("b.bin");
        let mut big = vec![7u8; 3 << 20];
        fs::write(&a, &big).unwrap();
        big[(3 << 20) - 1] = 8;
        fs::write(&b, &big).unwrap();
        let fa = fingerprint(&a).unwrap();
        assert!(fa.starts_with("3145728:"));
        assert_ne!(fa, fingerprint(&b).unwrap());
        fs::write(&a, b"abc").unwrap();
        assert_eq!(fingerprint(&a).unwrap(), format!("3:{:016x}", fnv1a(0xcbf2_9ce4_8422_2325, b"abc")));
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn 資料夾名稱去掉不允許的字元() {
        assert_eq!(safe_name("My: talk?"), "My- talk-");
        assert_eq!(safe_name("  ..  "), "Untitled");
    }
}
