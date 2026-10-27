// MP4 匯出的寫檔（spec §5.4）：前端（mediabunny）依位置分塊送來，這裡寫進使用者選的檔案。
// 分塊用 raw body（Uint8Array）傳，不經 JSON；檔案 id 與寫入位置放在標頭（x-export-id、x-export-pos）。

use std::collections::HashMap;
use std::fs::File;
use std::io::{Seek, SeekFrom, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;

use tauri::ipc::{InvokeBody, Request};
use tauri::State;

/// 開著的匯出檔：id → (檔案, 路徑)
#[derive(Default)]
pub struct ExportFiles {
    files: Mutex<HashMap<u32, (File, PathBuf)>>,
    next: AtomicU32,
}

/// 建立（覆寫）匯出檔，回傳 id
#[tauri::command]
pub fn export_open(path: String, state: State<'_, ExportFiles>) -> Result<u32, String> {
    let file = File::create(&path).map_err(|e| format!("無法建立 {path}：{e}"))?;
    let id = state.next.fetch_add(1, Ordering::Relaxed) + 1;
    state.files.lock().unwrap().insert(id, (file, PathBuf::from(path)));
    Ok(id)
}

/// 讀標頭的數字
fn header_number<T: std::str::FromStr>(request: &Request<'_>, name: &str) -> Result<T, String> {
    request
        .headers()
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse().ok())
        .ok_or_else(|| format!("缺少標頭 {name}"))
}

/// 在指定位置寫入一塊（raw body）
#[tauri::command]
pub fn export_write(request: Request<'_>, state: State<'_, ExportFiles>) -> Result<(), String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("export_write 要用 raw body（Uint8Array）".into());
    };
    let id: u32 = header_number(&request, "x-export-id")?;
    let pos: u64 = header_number(&request, "x-export-pos")?;
    let mut files = state.files.lock().unwrap();
    let (file, _) = files.get_mut(&id).ok_or("匯出檔已關閉")?;
    file.seek(SeekFrom::Start(pos)).map_err(|e| e.to_string())?;
    file.write_all(bytes).map_err(|e| e.to_string())
}

/// 寫完：關檔
#[tauri::command]
pub fn export_close(id: u32, state: State<'_, ExportFiles>) -> Result<(), String> {
    let (mut file, _) = state.files.lock().unwrap().remove(&id).ok_or("匯出檔已關閉")?;
    file.flush().map_err(|e| e.to_string())
}

/// 取消：關檔並刪除寫了一半的檔案
#[tauri::command]
pub fn export_abort(id: u32, state: State<'_, ExportFiles>) -> Result<(), String> {
    if let Some((file, path)) = state.files.lock().unwrap().remove(&id) {
        drop(file);
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// 寫文字檔（匯出旁邊的 SRT）
#[tauri::command]
pub fn write_text_file(path: String, text: String) -> Result<(), String> {
    std::fs::write(&path, text).map_err(|e| format!("無法寫入 {path}：{e}"))
}
