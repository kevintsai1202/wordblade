// 程式產生的素材（spec §5.15：AI 音效與配樂的 WAV）：前端用 OfflineAudioContext 算好的位元組寫進 app 資料夾的 generated/，
// 回傳路徑後走一般匯入（probe_media）。位元組用 raw body 傳（Uint8Array），檔名放在標頭 x-generated-name。

use std::path::PathBuf;

use tauri::ipc::{InvokeBody, Request};
use tauri::{AppHandle, Manager};

/// 產生檔的資料夾：%APPDATA%\com.wordblade.app\generated。
/// 不放快取資料夾：產生的音效被專案當素材引用，不能像代理檔那樣被清掉。
pub fn generated_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("generated");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 建議檔名 → 安全的主檔名：只留英數、-、_（其他換成 -），去掉副檔名，最長 60 字；空的用 generated
fn safe_stem(name: &str) -> String {
    let stem = name.rsplit_once('.').map_or(name, |(s, _)| s);
    let cleaned: String = stem
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '-' })
        .take(60)
        .collect();
    let trimmed = cleaned.trim_matches('-');
    if trimmed.is_empty() { "generated".into() } else { trimmed.into() }
}

/// 寫入一個產生的 WAV（不覆寫：同名就加 -2、-3…），放行給 asset 協定，回傳絕對路徑
#[tauri::command]
pub fn write_generated(app: AppHandle, request: Request<'_>) -> Result<String, String> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("write_generated 要用 raw body（Uint8Array）".into());
    };
    let name = request
        .headers()
        .get("x-generated-name")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("generated.wav");
    let dir = generated_dir(&app)?;
    let stem = safe_stem(name);
    let mut path = dir.join(format!("{stem}.wav"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}-{n}.wav"));
        n += 1;
    }
    std::fs::write(&path, bytes).map_err(|e| format!("無法寫入 {}：{e}", path.display()))?;
    app.asset_protocol_scope().allow_file(&path).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::safe_stem;

    #[test]
    fn 檔名只留安全字元() {
        assert_eq!(safe_stem("sfx-whoosh-1a2b.wav"), "sfx-whoosh-1a2b");
        assert_eq!(safe_stem("..\\..\\evil/name.wav"), "evil-name");
        assert_eq!(safe_stem("音效.wav"), "generated");
        assert_eq!(safe_stem(""), "generated");
    }
}
