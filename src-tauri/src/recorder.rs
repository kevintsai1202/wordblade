// 錄音退路（spec §5.18；開發者 2026-10-27 決定）：Windows 版 getUserMedia 失敗（NotReadableError、NotAllowedError、8 秒逾時，
// 例如 Kaspersky 依程式信任等級擋麥克風）時，改用 Windows 內建錄音機：PowerShell 腳本用 UI Automation 按錄音鍵、
// 從麥克風使用紀錄讀起訖時間、停止後在「文件」找最接近的 .m4a。腳本只有一份：scripts/recorder/sound-recorder.ps1（這裡內嵌）。
// 停止後把 .m4a 複製進開著的專案的 .data\generated\（沒開專案時放 app 資料夾的 generated\），走一般匯入（ffmpeg 讀得了 m4a）。

use std::path::{Path, PathBuf};
use std::process::Command;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::generated::generated_dir;

/// 錄音機腳本（ASCII；Windows PowerShell 5.1 讀無 BOM 的非 ASCII 會解析失敗）
const SCRIPT: &str = include_str!("../../scripts/recorder/sound-recorder.ps1");

/// 退路錄音的結果：錄音檔路徑（已搬進專案或 app 資料夾）、起訖（Unix 毫秒）
#[derive(Serialize)]
pub struct Recording {
    path: String,
    #[serde(rename = "startedAt")]
    started_at: Option<i64>,
    #[serde(rename = "stoppedAt")]
    stopped_at: i64,
}

/// 腳本寫到暫存資料夾後用 powershell.exe（5.1，每台 Windows 都有）執行，回傳印出的那一行 JSON
fn run(action: &str) -> Result<serde_json::Value, String> {
    let script = std::env::temp_dir().join("wordblade-sound-recorder.ps1");
    std::fs::write(&script, SCRIPT).map_err(|e| e.to_string())?;
    let mut cmd = Command::new("powershell.exe");
    cmd.args(["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File"]).arg(&script).arg(action);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let out = cmd.output().map_err(|e| format!("powershell-not-found: {e}"))?;
    parse(&String::from_utf8_lossy(&out.stdout))
}

/// 腳本輸出 → JSON；ok 是 false 時回傳 error 代碼
fn parse(stdout: &str) -> Result<serde_json::Value, String> {
    let line = stdout.lines().rev().find(|l| l.trim_start().starts_with('{')).ok_or_else(|| "recorder-no-output".to_string())?;
    let v: serde_json::Value = serde_json::from_str(line.trim()).map_err(|e| e.to_string())?;
    if v.get("ok").and_then(|o| o.as_bool()) == Some(true) { Ok(v) } else { Err(v.get("error").and_then(|e| e.as_str()).unwrap_or("recorder-failed").to_string()) }
}

/// 開始錄音：喚起錄音機並按錄音；回傳錄音開始的 Unix 毫秒
#[tauri::command]
pub async fn recorder_start() -> Result<i64, String> {
    let v = tauri::async_runtime::spawn_blocking(|| run("start")).await.map_err(|e| e.to_string())??;
    v.get("startedAt").and_then(|s| s.as_i64()).ok_or_else(|| "recorder-no-start".into())
}

/// 停止錄音：按停止、找到 .m4a，複製進 project_dir\.data\generated\（有開專案時）或 app 資料夾的 generated\
#[tauri::command]
pub async fn recorder_stop(app: AppHandle, project_dir: Option<String>) -> Result<Recording, String> {
    let v = tauri::async_runtime::spawn_blocking(|| run("stop")).await.map_err(|e| e.to_string())??;
    let src = PathBuf::from(v.get("path").and_then(|p| p.as_str()).ok_or("recorder-no-path")?);
    let dir = match project_dir.map(PathBuf::from).filter(|p| p.join(".data").is_dir()) {
        Some(p) => {
            let d = p.join(".data").join("generated");
            std::fs::create_dir_all(&d).map_err(|e| e.to_string())?;
            d
        }
        None => generated_dir(&app)?,
    };
    let stopped_at = v.get("stoppedAt").and_then(|s| s.as_i64()).unwrap_or(0);
    let dest = unique(&dir, &format!("voice-{stopped_at}"), "m4a");
    std::fs::copy(&src, &dest).map_err(|e| format!("無法複製錄音檔 {}：{e}", src.display()))?;
    app.asset_protocol_scope().allow_file(&dest).map_err(|e| e.to_string())?;
    Ok(Recording { path: dest.to_string_lossy().into_owned(), started_at: None, stopped_at })
}

/// 不覆寫：同名就加 -2、-3…
fn unique(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut path = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}-{n}.{ext}"));
        n += 1;
    }
    path
}

#[cfg(test)]
mod tests {
    use super::{parse, SCRIPT};

    #[test]
    fn 腳本只有_ascii() {
        assert!(SCRIPT.is_ascii());
    }

    #[test]
    fn 解析腳本輸出() {
        assert_eq!(parse("noise\n{\"ok\":true,\"startedAt\":5}\n").unwrap()["startedAt"], 5);
        assert_eq!(parse("{\"ok\":false,\"error\":\"record-button-not-found\"}").unwrap_err(), "record-button-not-found");
        assert_eq!(parse("").unwrap_err(), "recorder-no-output");
    }
}
