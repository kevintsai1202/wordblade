// 素材處理（spec §3、§5.13、§5.21、Q5）：ffprobe 讀規格、ffmpeg 產生 540p 代理檔、縮圖、音量包絡。
// ffmpeg 先找打包的 resources/ffmpeg/bin（LGPL 版，scripts/fetch-ffmpeg.ps1 下載），找不到才用 PATH 上的（開發機）。
// 重工作一次只跑一個（§5.21）；ffmpeg 的 stdout 只拿來傳資料（PCM、JPEG、進度），紀錄走 stderr。

use serde::Serialize;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager};

/// Windows 上啟動 ffmpeg 不要跳出主控台視窗
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
/// 包絡每秒幾個值（和 TS 的 ENVELOPE_RATE 一致）
const ENVELOPE_RATE: u32 = 100;
/// 算包絡時把聲音降到這個取樣率（單聲道），每格 80 個樣本
const ENVELOPE_SAMPLE_RATE: u32 = 8000;

/// 重工作的排隊鎖：代理檔一次只轉一支（§5.21）
static HEAVY: Mutex<()> = Mutex::new(());
/// 試編後選定的 H.264 編碼器（整個程式只試一次）
static ENCODER: OnceLock<String> = OnceLock::new();

/// ffprobe 讀出的素材規格（對應 TS 的 Media 欄位）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProbeInfo {
    kind: &'static str,
    duration: f64,
    width: Option<u32>,
    height: Option<u32>,
    fps: Option<f64>,
    audio: bool,
    has_alpha: bool,
    video_codec: Option<String>,
}

/// 找 ffmpeg／ffprobe 的執行檔：打包的優先，否則用 PATH
fn tool(app: &AppHandle, name: &str) -> PathBuf {
    if let Ok(dir) = app.path().resource_dir() {
        let bundled = dir.join("ffmpeg").join("bin").join(format!("{name}.exe"));
        if bundled.exists() {
            return bundled;
        }
    }
    PathBuf::from(name)
}

/// 建一個不跳視窗的指令
fn command(program: &Path) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// 執行並取回 stdout；失敗時把 stderr 的最後幾行當錯誤訊息
fn run(mut cmd: Command) -> Result<Vec<u8>, String> {
    let out = cmd.output().map_err(|e| format!("無法啟動 ffmpeg：{e}"))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: Vec<&str> = err.lines().rev().take(3).collect();
        return Err(tail.into_iter().rev().collect::<Vec<_>>().join("\n"));
    }
    Ok(out.stdout)
}

/// 把 "30000/1001" 這種分數轉成數字
fn parse_rate(s: &str) -> Option<f64> {
    let (n, d) = s.split_once('/')?;
    let (n, d): (f64, f64) = (n.parse().ok()?, d.parse().ok()?);
    (d > 0.0 && n > 0.0).then(|| n / d)
}

/// 讀素材規格，並讓預覽可以經 asset 協定讀這個檔（只放行使用者匯入的檔案，不開放整顆硬碟）
#[tauri::command]
pub async fn probe_media(app: AppHandle, path: String) -> Result<ProbeInfo, String> {
    let ffprobe = tool(&app, "ffprobe");
    let p = path.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = command(&ffprobe);
        cmd.args(["-v", "error", "-print_format", "json", "-show_format", "-show_streams", &p]);
        run(cmd)
    })
    .await
    .map_err(|e| e.to_string())??;
    let json: serde_json::Value = serde_json::from_slice(&out).map_err(|e| e.to_string())?;
    let streams = json["streams"].as_array().cloned().unwrap_or_default();
    // 封面圖（attached_pic）不算影像
    let video = streams.iter().find(|s| s["codec_type"] == "video" && s["disposition"]["attached_pic"] != 1);
    let audio = streams.iter().any(|s| s["codec_type"] == "audio");
    let duration: f64 = json["format"]["duration"].as_str().and_then(|d| d.parse().ok()).unwrap_or(0.0);
    let codec = video.and_then(|v| v["codec_name"].as_str()).map(str::to_string);
    let still = matches!(codec.as_deref(), Some("png" | "mjpeg" | "webp" | "bmp" | "gif")) && duration < 0.5;
    let kind = match (video, still) {
        (Some(_), true) => "image",
        (Some(_), false) => "video",
        (None, _) if audio => "audio",
        _ => return Err("不是影片、圖片或聲音檔".into()),
    };
    let pix = video.and_then(|v| v["pix_fmt"].as_str()).unwrap_or("");
    let info = ProbeInfo {
        kind,
        duration,
        width: video.and_then(|v| v["width"].as_u64()).map(|w| w as u32),
        height: video.and_then(|v| v["height"].as_u64()).map(|h| h as u32),
        fps: video.and_then(|v| v["avg_frame_rate"].as_str()).and_then(parse_rate),
        audio,
        has_alpha: pix.starts_with("yuva") || pix.contains("rgba") || pix.contains("argb") || pix.contains("bgra"),
        video_codec: codec,
    };
    app.asset_protocol_scope().allow_file(&path).map_err(|e| e.to_string())?;
    Ok(info)
}

/// 實際試編 1 格選 H.264 編碼器：qsv → nvenc → amf → mf（只看清單不準，§3）
fn pick_encoder(ffmpeg: &Path) -> String {
    ENCODER
        .get_or_init(|| {
            for enc in ["h264_qsv", "h264_nvenc", "h264_amf", "h264_mf"] {
                let mut cmd = command(ffmpeg);
                cmd.args(["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=black:s=320x240:d=0.1"])
                    .args(["-frames:v", "1", "-vf", "format=nv12", "-c:v", enc, "-f", "null", "-"]);
                if run(cmd).is_ok() {
                    return enc.to_string();
                }
            }
            "h264_mf".to_string()
        })
        .clone()
}

/// 代理檔放的資料夾：%LOCALAPPDATA%\com.wordblade.app\proxies（專案檔做好之後改放專案旁的 proxies/）
pub fn proxy_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("proxies");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 代理檔進度事件
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProxyProgress {
    media_id: String,
    ratio: f64,
}

/// 代理檔沒用到幾天就在啟動時刪掉
const PROXY_KEEP_DAYS: u64 = 30;

/// FNV-1a 64 位元雜湊（自己寫，結果不隨 Rust 版本改變，代理檔名才穩定）
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    h
}

/// 原檔的快取鍵：「路徑＋大小＋修改時間」的雜湊（16 位十六進位），同一支檔案重複匯入就重用；原檔改過就換新的
fn source_key(path: &str) -> Result<String, String> {
    let meta = std::fs::metadata(path).map_err(|e| e.to_string())?;
    let mtime = meta.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
    let key = format!("{}|{}|{}", path.to_lowercase(), meta.len(), mtime);
    Ok(format!("{:016x}", fnv1a(key.as_bytes())))
}

/// 代理檔的檔名：原檔的快取鍵＋副檔名
fn proxy_name(path: &str, alpha: bool) -> Result<String, String> {
    Ok(format!("{}.{}", source_key(path)?, if alpha { "webm" } else { "mp4" }))
}

/// 縮圖序列的根資料夾：%LOCALAPPDATA%\com.wordblade.app	humbs（每支原檔一個子資料夾，D39）
pub fn thumbs_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("thumbs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 啟動時清理縮圖快取：刪掉超過 30 天沒用到的原檔資料夾（用到時會更新資料夾的完成標記時間）
pub fn cleanup_thumbs(root: &Path) {
    let Ok(entries) = std::fs::read_dir(root) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let marker = entry.path().join("used");
        let age = std::fs::metadata(&marker).ok().and_then(|m| m.modified().ok()).and_then(|t| now.duration_since(t).ok()).map(|d| d.as_secs()).unwrap_or(u64::MAX);
        if age > PROXY_KEEP_DAYS * 24 * 3600 {
            let _ = std::fs::remove_dir_all(entry.path());
        }
    }
}

/// 縮圖序列的狀態：原檔資料夾（前端組縮圖網址用）與各層做好的段（看 t<層>/c<段>.done）
#[derive(Serialize)]
pub struct ThumbStatus {
    base: String,
    done: Vec<Vec<u32>>,
}

/// 讀某支原檔的縮圖狀態；順便記下「最近用過」，啟動清理時不會刪掉
#[tauri::command]
pub async fn thumbs_status(app: AppHandle, path: String, tiers: u32, chunks: u32) -> Result<ThumbStatus, String> {
    let base = thumbs_root(&app)?.join(source_key(&path)?);
    std::fs::create_dir_all(&base).map_err(|e| e.to_string())?;
    std::fs::write(base.join("used"), b"").map_err(|e| e.to_string())?;
    let done = (0..tiers).map(|t| (0..chunks).filter(|c| base.join(format!("t{t}")).join(format!("c{c}.done")).exists()).collect()).collect();
    Ok(ThumbStatus { base: base.to_string_lossy().to_string(), done })
}

/// 產生某支原檔第 tier 層的第 chunk 段縮圖：從 source（原檔或代理檔）的 start 秒起 duration 秒，每 interval 秒一張、寬 width，
/// 存成 t<層>/<索引>.jpg（索引從 first_index 起、共 count 張），做完寫完成標記。key_only：只解關鍵幀（匯入時從原檔做第 0 層，快很多，位置差在一個 GOP 內）。
/// 和代理檔共用重工作鎖，不會同時跑。
/// fps 濾鏡加 eof_action=pass：片段比間隔短（或最後一段）時最後一張才不會被丟掉；再用 -frames:v 限制張數，免得多寫一張蓋到下一段。
/// mjpeg 編碼器不收有限範圍的 YUV（ffmpeg 9 直接報錯），先轉成全範圍。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn thumbs_make(app: AppHandle, path: String, source: String, tier: u32, chunk: u32, start: f64, duration: f64, interval: f64, width: u32, first_index: u32, count: u32, key_only: bool) -> Result<(), String> {
    let dir = thumbs_root(&app)?.join(source_key(&path)?).join(format!("t{tier}"));
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let ffmpeg = tool(&app, "ffmpeg");
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _guard = HEAVY.lock().map_err(|e| e.to_string())?;
        let mut cmd = command(&ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostats", "-y"]);
        if key_only {
            cmd.args(["-skip_frame", "nokey"]);
        }
        cmd.args(["-ss", &format!("{start:.3}"), "-t", &format!("{duration:.3}"), "-i", &source])
            .args(["-an", "-vf", &format!("fps={}:eof_action=pass,scale={width}:-2:out_range=full,format=yuvj420p", 1.0 / interval)])
            .args(["-frames:v", &count.max(1).to_string(), "-q:v", "5"])
            .args(["-start_number", &first_index.to_string(), "-f", "image2"])
            .arg(dir.join("%d.jpg"));
        run(cmd)?;
        std::fs::write(dir.join(format!("c{chunk}.done")), b"").map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 更新檔案的修改時間，表示「最近用過」，啟動清理時不會刪掉
fn touch(path: &Path) {
    if let Ok(f) = std::fs::File::options().write(true).open(path) {
        let _ = f.set_modified(std::time::SystemTime::now());
    }
}

/// 啟動時清理代理檔資料夾：刪掉超過 30 天沒用到的代理檔，以及中斷留下的暫存檔（*.part.*）
pub fn cleanup_proxies(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let now = std::time::SystemTime::now();
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let age = entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| now.duration_since(t).ok()).map(|d| d.as_secs()).unwrap_or(0);
        if name.contains(".part.") || age > PROXY_KEEP_DAYS * 24 * 3600 {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// 刪掉某支原檔的代理檔（自我檢查量「第一次產生」的時間用）
#[tauri::command]
pub async fn evict_proxy(app: AppHandle, path: String, alpha: bool) -> Result<(), String> {
    let out = proxy_dir(&app)?.join(proxy_name(&path, alpha)?);
    if out.exists() {
        std::fs::remove_file(out).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 產生 540p 預覽用代理檔，回傳代理檔路徑；同一支原檔已經有就直接回傳（Q5、§5.21）。
/// 不透明：H.264（試編選定的硬體／系統編碼器）＋AAC、關鍵幀 1 秒、faststart。
/// 帶透明（alpha）：VP9 透明 WebM（libvpx-vp9、yuva420p，-auto-alt-ref 0 才保得住透明）＋Opus。
#[tauri::command]
pub async fn make_proxy(app: AppHandle, media_id: String, path: String, duration: f64, fps: Option<f64>, alpha: bool) -> Result<String, String> {
    let out = proxy_dir(&app)?.join(proxy_name(&path, alpha)?);
    let out_str = out.to_string_lossy().to_string();
    if out.exists() {
        touch(&out);
        return Ok(out_str);
    }
    let ffmpeg = tool(&app, "ffmpeg");
    let tmp = out.with_extension(if alpha { "part.webm" } else { "part.mp4" });
    let app2 = app.clone();
    let id = media_id.clone();
    let tmp2 = tmp.clone();
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let _guard = HEAVY.lock().map_err(|e| e.to_string())?;
        let gop = fps.unwrap_or(30.0).round().max(1.0).to_string();
        let mut cmd = command(&ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-nostats", "-y", "-i", &path, "-map", "0:v:0", "-map", "0:a:0?"]);
        let encoder = if alpha {
            cmd.args(["-vf", "scale=-2:540,format=yuva420p", "-c:v", "libvpx-vp9", "-b:v", "1500k", "-auto-alt-ref", "0"])
                .args(["-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-g", &gop, "-c:a", "libopus", "-b:a", "96k"]);
            "libvpx-vp9".to_string()
        } else {
            let encoder = pick_encoder(&ffmpeg);
            cmd.args(["-vf", "scale=-2:540,format=nv12", "-c:v", &encoder, "-b:v", "2500k", "-g", &gop])
                .args(["-c:a", "aac", "-b:a", "128k", "-ac", "2", "-movflags", "+faststart"]);
            encoder
        };
        cmd.args(["-progress", "pipe:1"]).arg(&tmp2).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| format!("無法啟動 ffmpeg：{e}"))?;
        // 讀 -progress 的 out_time_us，換算成比例發給前端
        for line in BufReader::new(child.stdout.take().unwrap()).lines().map_while(Result::ok) {
            if let Some(us) = line.strip_prefix("out_time_us=").and_then(|v| v.parse::<f64>().ok()) {
                let ratio = if duration > 0.0 { (us / 1e6 / duration).clamp(0.0, 1.0) } else { 0.0 };
                let _ = app2.emit("proxy-progress", ProxyProgress { media_id: id.clone(), ratio });
            }
        }
        let mut err = String::new();
        child.stderr.take().unwrap().read_to_string(&mut err).ok();
        let status = child.wait().map_err(|e| e.to_string())?;
        if !status.success() {
            let _ = std::fs::remove_file(&tmp2);
            return Err(format!("代理檔產生失敗（{encoder}）：{}", err.lines().last().unwrap_or("")));
        }
        Ok(())
    })
    .await
    .map_err(|e| e.to_string())??;
    std::fs::rename(&tmp, &out).map_err(|e| e.to_string())?;
    Ok(out_str)
}

/// 找示範專案的素材資料夾 samples/（只在開發機的 repo 裡有）：從執行檔與目前目錄往上找，
/// 找到就放進 asset 協定的允許清單並回傳絕對路徑；找不到回 None（安裝版沒有示範素材）
#[tauri::command]
pub fn find_samples_dir(app: AppHandle) -> Option<String> {
    let starts = [std::env::current_exe().ok().and_then(|p| p.parent().map(Path::to_path_buf)), std::env::current_dir().ok()];
    for start in starts.into_iter().flatten() {
        for dir in start.ancestors() {
            let samples = dir.join("samples");
            if samples.join("lecture-a.en.mp4").exists() {
                app.asset_protocol_scope().allow_directory(&samples, true).ok()?;
                return Some(samples.to_string_lossy().to_string());
            }
        }
    }
    None
}

/// 音量包絡：ffmpeg 解成 8 kHz 單聲道 16 位元 PCM，每 10 ms 算一個 RMS，回傳 little-endian f32 的位元組
#[tauri::command]
pub async fn media_envelope(app: AppHandle, path: String) -> Result<tauri::ipc::Response, String> {
    let ffmpeg = tool(&app, "ffmpeg");
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let mut cmd = command(&ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-i", &path, "-vn", "-ac", "1"])
            .args(["-ar", &ENVELOPE_SAMPLE_RATE.to_string(), "-f", "s16le", "-"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let mut child = cmd.spawn().map_err(|e| format!("無法啟動 ffmpeg：{e}"))?;
        let window = (ENVELOPE_SAMPLE_RATE / ENVELOPE_RATE) as usize;
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let mut buf = vec![0u8; window * 2];
        let mut out = Vec::new();
        loop {
            // 讀滿一格（最後一格可能不滿）
            let mut filled = 0;
            while filled < buf.len() {
                match reader.read(&mut buf[filled..]) {
                    Ok(0) => break,
                    Ok(n) => filled += n,
                    Err(e) => return Err(e.to_string()),
                }
            }
            let samples = filled / 2;
            if samples == 0 {
                break;
            }
            let sum: f64 = buf[..samples * 2]
                .chunks_exact(2)
                .map(|c| {
                    let v = i16::from_le_bytes([c[0], c[1]]) as f64 / 32768.0;
                    v * v
                })
                .sum();
            out.extend_from_slice(&((sum / samples as f64).sqrt() as f32).to_le_bytes());
            if filled < buf.len() {
                break;
            }
        }
        child.wait().map_err(|e| e.to_string())?;
        Ok(out)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// ASR 音訊（spec §5.2）：素材 [start, start+duration) 解成 16 kHz 單聲道 16 位元 PCM（little-endian，沒有 WAV 檔頭；
/// 檔頭由前端補，ffmpeg 寫到管線時填不了 WAV 的長度欄位）
#[tauri::command]
pub async fn asr_pcm(app: AppHandle, path: String, start: f64, duration: f64) -> Result<tauri::ipc::Response, String> {
    let ffmpeg = tool(&app, "ffmpeg");
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = command(&ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-ss", &format!("{start:.3}"), "-t", &format!("{duration:.3}"), "-i", &path])
            .args(["-vn", "-ac", "1", "-ar", "16000", "-f", "s16le", "-"]);
        run(cmd)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 縮圖：取素材時間 at 的一格，寬 160 的 JPEG 位元組
#[tauri::command]
pub async fn media_thumbnail(app: AppHandle, path: String, at: f64) -> Result<tauri::ipc::Response, String> {
    let ffmpeg = tool(&app, "ffmpeg");
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let mut cmd = command(&ffmpeg);
        cmd.args(["-hide_banner", "-loglevel", "error", "-ss", &format!("{at:.3}"), "-i", &path])
            .args(["-frames:v", "1", "-vf", "scale=160:-2", "-f", "image2pipe", "-c:v", "mjpeg", "-"]);
        run(cmd)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// 目前用的 ffmpeg 位置與選定的編碼器（診斷與安裝後驗證用）
#[tauri::command]
pub async fn media_tools(app: AppHandle) -> Result<serde_json::Value, String> {
    let ffmpeg = tool(&app, "ffmpeg");
    let f2 = ffmpeg.clone();
    let encoder = tauri::async_runtime::spawn_blocking(move || pick_encoder(&f2)).await.map_err(|e| e.to_string())?;
    Ok(serde_json::json!({ "ffmpeg": ffmpeg.to_string_lossy(), "encoder": encoder }))
}
