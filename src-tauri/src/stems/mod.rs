// 聲音分離（spec §5.14、P1-10、D28）：把素材的聲音拆成「人聲」與「背景音樂」兩個 WAV。
// 只跑一個模型 Kim_Vocal_2（MDX-Net ONNX），背景＝原音減人聲；推論用 ort（onnxruntime，Windows 先試 DirectML，不行退回 CPU）。
// 流程：ffmpeg 解成 44.1 kHz 立體聲 f32 暫存檔 → 掃一遍定峰值正規化 → 串流 demix，邊算邊寫兩個 16-bit WAV（長片不佔記憶體）。
// 模型檔不放進安裝檔：第一次用時下載到 app 資料夾的 models\ 並驗 SHA-256。
// 開發與測試可用環境變數 WORDBLADE_MODEL_DIR 指到現成的模型資料夾，就不用下載。

pub mod dsp;
pub mod mdx;

use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use self::mdx::{normalize_gain, separate_stream, OrtMdx, KIM_VOCAL_2, SAMPLE_RATE};

/// 模型檔名與來源（TRvlvr/model_repo 的 all_public_uvr_models 發行版；上游授權不明，見 README「Third-party models」）
const MODEL_FILE: &str = "Kim_Vocal_2.onnx";
const MODEL_URL: &str = "https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx";
/// 模型檔的位元組數與 SHA-256（自己算的；audio-separator 印的是 32 字元的 hash，不是 SHA-256）
const MODEL_SIZE: u64 = 66_759_214;
const MODEL_SHA256: &str = "ce74ef3b6a6024ce44211a07be9cf8bc6d87728cc852a68ab34eb8e58cde9c8b";

/// 進行中的分離工作的取消旗標，鍵是 media_id
static CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

/// 取消旗標表（第一次用到才建）
fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    CANCELS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 分離結果：兩個 WAV 的絕對路徑，加上診斷資訊（用的執行提供者、耗時秒數、是否直接用快取）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StemResult {
    vocals: String,
    background: String,
    /// "directml"、"cpu"，快取命中時是 "cache"
    provider: String,
    /// 本次花的秒數（不含下載）；快取命中是 0
    seconds: f64,
    /// DirectML 失敗退回 CPU 的原因（沒退回就沒有）
    note: Option<String>,
}

/// 進度事件（stems-progress）：stage 是 "download"（下載模型）或 "separate"（分離），ratio 0～1
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StemProgress {
    media_id: String,
    stage: &'static str,
    ratio: f64,
}

/// 模型資料夾：WORDBLADE_MODEL_DIR 有設且存在就用它（開發與測試），否則 %APPDATA%\com.wordblade.app\models
fn model_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(dir) = std::env::var("WORDBLADE_MODEL_DIR") {
        let p = PathBuf::from(dir);
        if p.is_dir() {
            return Ok(p);
        }
    }
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 算檔案的 SHA-256（小寫十六進位）；64 KB 一塊讀，不整檔進記憶體
pub fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = File::open(path).map_err(|e| format!("{}：{e}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    loop {
        let n = f.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 檔案存在、位元組數與 SHA-256 都對才算驗證通過（大小不對就不用算雜湊）
pub fn verify_file(path: &Path, size: u64, sha256: &str) -> bool {
    match std::fs::metadata(path) {
        Ok(m) if m.len() == size => sha256_file(path).map(|h| h.eq_ignore_ascii_case(sha256)).unwrap_or(false),
        _ => false,
    }
}

/// 確保模型檔可用，回傳路徑：已有且驗證通過就直接用；否則下載（串流、回報進度、可取消）到 .part，驗證通過才改名。
/// 下載與驗證都是阻塞的，要在 spawn_blocking 裡呼叫。
fn ensure_model(dir: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(f64)) -> Result<PathBuf, String> {
    let path = dir.join(MODEL_FILE);
    if verify_file(&path, MODEL_SIZE, MODEL_SHA256) {
        return Ok(path);
    }
    // 環境變數指定的資料夾（開發用）有檔卻驗證失敗：不要覆蓋別人的檔，直接報錯
    if path.exists() && std::env::var("WORDBLADE_MODEL_DIR").is_ok() {
        return Err(format!("{} failed SHA-256 verification", path.display()));
    }
    let part = dir.join(format!("{MODEL_FILE}.part"));
    let result = download(MODEL_URL, &part, cancel, progress).and_then(|(size, sha)| {
        if size != MODEL_SIZE || !sha.eq_ignore_ascii_case(MODEL_SHA256) {
            return Err(format!("Downloaded model failed verification (size {size}, sha256 {sha})"));
        }
        let _ = std::fs::remove_file(&path);
        std::fs::rename(&part, &path).map_err(|e| e.to_string())
    });
    if let Err(e) = result {
        let _ = std::fs::remove_file(&part);
        return Err(e);
    }
    Ok(path)
}

/// 下載 url 到 dest，邊收邊算 SHA-256 並回報進度（0～1，有 Content-Length 才有）；回 (位元組數, SHA-256)
fn download(url: &str, dest: &Path, cancel: &AtomicBool, progress: &mut dyn FnMut(f64)) -> Result<(u64, String), String> {
    let resp = ureq::get(url).call().map_err(|e| format!("Model download failed: {e}"))?;
    let total: u64 = resp.headers().get("content-length").and_then(|v| v.to_str().ok()).and_then(|v| v.parse().ok()).unwrap_or(MODEL_SIZE);
    let mut body = resp.into_body().into_reader();
    let mut out = BufWriter::new(File::create(dest).map_err(|e| e.to_string())?);
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 64 * 1024];
    let mut got = 0u64;
    // 上次回報進度的百分比，避免每個 64 KB 都發事件
    let mut last_pct = u64::MAX;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let n = body.read(&mut buf).map_err(|e| format!("Model download failed: {e}"))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
        out.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        got += n as u64;
        let pct = got * 100 / total.max(1);
        if pct != last_pct {
            last_pct = pct;
            progress((got as f64 / total.max(1) as f64).min(1.0));
        }
    }
    out.flush().map_err(|e| e.to_string())?;
    Ok((got, format!("{:x}", hasher.finalize())))
}

/// 檔名可用的指紋：把 "大小:雜湊" 的冒號換成 "-"（Windows 檔名不能有冒號）
fn fingerprint_stem(fp: &str) -> String {
    fp.replace(':', "-")
}

/// 輸出 WAV 的路徑：<dir>/<指紋>-vocals.wav 與 -background.wav
fn output_paths(dir: &Path, fp: &str) -> (PathBuf, PathBuf) {
    let stem = fingerprint_stem(fp);
    (dir.join(format!("{stem}-vocals.wav")), dir.join(format!("{stem}-background.wav")))
}

/// 快取命中：兩個輸出檔都在才回路徑（分離中途寫的是 .part，改名在最後一步，所以兩個都在就是完整的）
fn cached_outputs(dir: &Path, fp: &str) -> Option<(PathBuf, PathBuf)> {
    let (v, b) = output_paths(dir, fp);
    (v.is_file() && b.is_file()).then_some((v, b))
}

/// 輸出資料夾：有專案資料夾（且已有 .data）就放 <專案>\.data\stems\，否則 app 快取資料夾的 stems\
fn output_dir(app: &AppHandle, project_dir: Option<&str>) -> Result<PathBuf, String> {
    let project = project_dir.map(PathBuf::from).filter(|p| p.join(".data").is_dir());
    let dir = match project {
        Some(p) => p.join(".data").join("stems"),
        None => app.path().app_cache_dir().map_err(|e| e.to_string())?.join("stems"),
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// 暫存的 raw 檔（解碼後的 f32 立體聲），離開範圍時刪除
struct TempFile(PathBuf);

impl Drop for TempFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// 用 ffmpeg 把素材的第一條音軌解成 44.1 kHz 立體聲 f32le 寫到 raw；等待期間每 100 ms 看取消旗標，取消就殺掉 ffmpeg。
/// 沒有音軌或解碼失敗回 ffmpeg stderr 的最後幾行。
fn decode_to_raw(ffmpeg: &Path, source: &str, raw: &Path, cancel: &AtomicBool) -> Result<(), String> {
    let mut cmd = crate::media::command(ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-nostats", "-y", "-i", source, "-map", "0:a:0", "-vn"])
        .args(["-ac", "2", "-ar", &SAMPLE_RATE.to_string(), "-f", "f32le"])
        .arg(raw)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().map_err(|e| format!("無法啟動 ffmpeg：{e}"))?;
    let mut stderr = child.stderr.take().unwrap();
    // 另開執行緒收 stderr，免得 ffmpeg 寫滿管線卡住
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        stderr.read_to_string(&mut s).ok();
        s
    });
    let status = loop {
        if cancel.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            return Err("cancelled".into());
        }
        if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
            break st;
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    let err = reader.join().unwrap_or_default();
    if !status.success() {
        let tail: Vec<&str> = err.lines().rev().take(3).collect();
        return Err(format!("Couldn't decode the audio: {}", tail.into_iter().rev().collect::<Vec<_>>().join(" ")));
    }
    Ok(())
}

/// raw 檔（f32le 立體聲交錯）的隨機讀取器：read(a, b) 回樣本 [a, b) 的 [2][b-a]。用 RefCell 讓它能當 Fn 傳。
struct RawReader {
    file: std::cell::RefCell<BufReader<File>>,
}

impl RawReader {
    /// 開啟 raw 檔
    fn open(path: &Path) -> Result<Self, String> {
        Ok(Self { file: std::cell::RefCell::new(BufReader::with_capacity(1 << 20, File::open(path).map_err(|e| e.to_string())?)) })
    }

    /// 讀樣本 [a, b)（每個樣本 8 位元組：L、R 各一個 f32）；讀不滿的部分補 0
    fn read(&self, a: usize, b: usize) -> Vec<Vec<f32>> {
        let n = b - a;
        let mut bytes = vec![0u8; n * 8];
        let mut f = self.file.borrow_mut();
        if f.seek(SeekFrom::Start(a as u64 * 8)).is_ok() {
            let mut filled = 0;
            while filled < bytes.len() {
                match f.read(&mut bytes[filled..]) {
                    Ok(0) | Err(_) => break,
                    Ok(k) => filled += k,
                }
            }
        }
        let mut out = vec![Vec::with_capacity(n); 2];
        for frame in bytes.chunks_exact(8) {
            out[0].push(f32::from_le_bytes([frame[0], frame[1], frame[2], frame[3]]));
            out[1].push(f32::from_le_bytes([frame[4], frame[5], frame[6], frame[7]]));
        }
        out
    }
}

/// 掃一遍 raw 檔求峰值（絕對值最大的樣本），用來定峰值正規化的增益；每次讀 1M 個 f32
fn scan_peak(path: &Path, cancel: &AtomicBool) -> Result<f32, String> {
    let mut f = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
    let mut buf = vec![0u8; 4 << 20];
    let mut peak = 0f32;
    loop {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let mut filled = 0;
        while filled < buf.len() {
            let n = f.read(&mut buf[filled..]).map_err(|e| e.to_string())?;
            if n == 0 {
                break;
            }
            filled += n;
        }
        for c in buf[..filled - filled % 4].chunks_exact(4) {
            peak = peak.max(f32::from_le_bytes([c[0], c[1], c[2], c[3]]).abs());
        }
        if filled < buf.len() {
            return Ok(peak);
        }
    }
}

/// 浮點樣本 → 16-bit（超出 ±1 的削到邊界）
fn to_i16(v: f32) -> i16 {
    (v.clamp(-1.0, 1.0) * 32767.0).round() as i16
}

/// 建一個 44.1 kHz 立體聲 16-bit 的串流 WAV 寫入器
fn wav_writer(path: &Path) -> Result<hound::WavWriter<BufWriter<File>>, String> {
    let spec = hound::WavSpec { channels: 2, sample_rate: SAMPLE_RATE, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    hound::WavWriter::create(path, spec).map_err(|e| e.to_string())
}

/// 在已有的 raw 檔上跑分離，邊算邊寫 vocals_part、background_part 兩個 WAV；回 (provider 名稱, 退回原因)。
/// 阻塞、重運算，要在 spawn_blocking 裡呼叫。
fn run_separation(
    model_path: &Path,
    raw: &Path,
    vocals_part: &Path,
    background_part: &Path,
    cancel: &AtomicBool,
    progress: &mut dyn FnMut(f64),
) -> Result<(&'static str, Option<String>), String> {
    let n_samples = (std::fs::metadata(raw).map_err(|e| e.to_string())?.len() / 8) as usize;
    if n_samples == 0 {
        return Err("The audio is empty".into());
    }
    let gain = normalize_gain(scan_peak(raw, cancel)?);
    let (mut model, note) = OrtMdx::open_auto(&model_path.to_string_lossy(), KIM_VOCAL_2, None)?;
    let provider = model.provider.name();
    let reader = RawReader::open(raw)?;
    let mut vw = wav_writer(vocals_part)?;
    let mut bw = wav_writer(background_part)?;
    let mut write_err: Option<String> = None;
    {
        let read_mix = |a: usize, b: usize| reader.read(a, b);
        let mut sink = |p: &[Vec<f32>], s: &[Vec<f32>]| {
            for i in 0..p[0].len() {
                for c in 0..2 {
                    if vw.write_sample(to_i16(p[c][i])).is_err() || bw.write_sample(to_i16(s[c][i])).is_err() {
                        write_err = Some("Couldn't write the separated audio".into());
                    }
                }
            }
        };
        let mut on_progress = |done: usize, total: usize| progress(done as f64 / total.max(1) as f64);
        let is_cancelled = || cancel.load(Ordering::Relaxed);
        separate_stream(&mut model, KIM_VOCAL_2.compensate, n_samples, gain, &read_mix, &mut sink, Some(&mut on_progress), Some(&is_cancelled))?;
    }
    if let Some(e) = write_err {
        return Err(e);
    }
    vw.finalize().map_err(|e| e.to_string())?;
    bw.finalize().map_err(|e| e.to_string())?;
    Ok((provider, note))
}

/// 人聲／背景音樂分離（P1-10）。回傳兩個 WAV 的絕對路徑；已經分離過（兩個輸出檔都在）就直接回傳。
/// 輸出放 <專案>\.data\stems\<指紋>-vocals.wav／-background.wav（有開專案資料夾時），否則 app 快取資料夾的 stems\。
/// 先確保模型（沒有就下載，進度 stage="download"），再分離（stage="separate"）；重工作與代理檔共用一把鎖。
/// 期間可由 separate_cancel(media_id) 取消，回錯誤 "cancelled"。
#[tauri::command]
pub async fn separate_vocals(app: AppHandle, media_id: String, path: String, project_dir: Option<String>) -> Result<StemResult, String> {
    let fp = crate::project::fingerprint(Path::new(&path))?;
    let out_dir = output_dir(&app, project_dir.as_deref())?;
    let allow = |v: &Path, b: &Path| -> Result<(), String> {
        app.asset_protocol_scope().allow_file(v).map_err(|e| e.to_string())?;
        app.asset_protocol_scope().allow_file(b).map_err(|e| e.to_string())
    };
    if let Some((v, b)) = cached_outputs(&out_dir, &fp) {
        allow(&v, &b)?;
        return Ok(StemResult { vocals: v.to_string_lossy().into_owned(), background: b.to_string_lossy().into_owned(), provider: "cache".into(), seconds: 0.0, note: None });
    }
    let cancel = Arc::new(AtomicBool::new(false));
    cancels().lock().map_err(|e| e.to_string())?.insert(media_id.clone(), cancel.clone());
    let ffmpeg = crate::media::tool(&app, "ffmpeg");
    let models = model_dir(&app)?;
    let tmp_dir = app.path().app_cache_dir().map_err(|e| e.to_string())?.join("stems");
    std::fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
    let app2 = app.clone();
    let id = media_id.clone();
    let out_dir2 = out_dir.clone();
    let fp2 = fp.clone();
    let result = tauri::async_runtime::spawn_blocking(move || -> Result<StemResult, String> {
        let emit = |stage: &'static str, ratio: f64| {
            let _ = app2.emit("stems-progress", StemProgress { media_id: id.clone(), stage, ratio });
        };
        let model_path = ensure_model(&models, &cancel, &mut |r| emit("download", r))?;
        let _guard = crate::media::HEAVY.lock().map_err(|e| e.to_string())?;
        emit("separate", 0.0);
        let started = Instant::now();
        // 暫存 raw 檔名帶 media_id（淨化）與 pid，同時兩支也不會互相覆蓋
        let safe_id: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_').collect();
        let raw = TempFile(tmp_dir.join(format!("tmp-{safe_id}-{}.raw", std::process::id())));
        decode_to_raw(&ffmpeg, &path, &raw.0, &cancel)?;
        let (v, b) = output_paths(&out_dir2, &fp2);
        let (vp, bp) = (v.with_extension("part.wav"), b.with_extension("part.wav"));
        let ran = run_separation(&model_path, &raw.0, &vp, &bp, &cancel, &mut |r| emit("separate", r));
        let (provider, note) = match ran {
            Ok(x) => x,
            Err(e) => {
                let _ = std::fs::remove_file(&vp);
                let _ = std::fs::remove_file(&bp);
                return Err(e);
            }
        };
        std::fs::rename(&vp, &v).map_err(|e| e.to_string())?;
        std::fs::rename(&bp, &b).map_err(|e| e.to_string())?;
        Ok(StemResult { vocals: v.to_string_lossy().into_owned(), background: b.to_string_lossy().into_owned(), provider: provider.into(), seconds: started.elapsed().as_secs_f64(), note })
    })
    .await
    .map_err(|e| e.to_string());
    if let Ok(mut map) = cancels().lock() {
        map.remove(&media_id);
    }
    let result = result??;
    allow(Path::new(&result.vocals), Path::new(&result.background))?;
    Ok(result)
}

/// 取消某支素材進行中的分離（下載、解碼或推論都會在下一個檢查點停下）；沒有進行中的工作就什麼也不做
#[tauri::command]
pub fn separate_cancel(media_id: String) {
    if let Ok(map) = cancels().lock() {
        if let Some(flag) = map.get(&media_id) {
            flag.store(true, Ordering::Relaxed);
        }
    }
}

/// 刪掉某支素材已有的分離結果（自我檢查量「第一次分離」的時間用）
#[tauri::command]
pub fn separate_evict(app: AppHandle, path: String, project_dir: Option<String>) -> Result<(), String> {
    let fp = crate::project::fingerprint(Path::new(&path))?;
    let (v, b) = output_paths(&output_dir(&app, project_dir.as_deref())?, &fp);
    let _ = std::fs::remove_file(v);
    let _ = std::fs::remove_file(b);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 在系統暫存資料夾建一個測試用的獨立資料夾
    fn temp_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("wordblade-stems-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// SHA-256 驗證：已知內容 "abc" 的雜湊正確才通過；內容或大小不對都不通過
    #[test]
    fn sha256_verification() {
        let d = temp_dir("sha");
        let f = d.join("abc.bin");
        std::fs::write(&f, b"abc").unwrap();
        let abc = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
        assert_eq!(sha256_file(&f).unwrap(), abc);
        assert!(verify_file(&f, 3, abc));
        assert!(!verify_file(&f, 4, abc), "大小不對");
        assert!(!verify_file(&f, 3, &abc.replace('b', "c")), "雜湊不對");
        assert!(!verify_file(&d.join("none"), 3, abc), "檔案不存在");
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 快取命中：兩個輸出檔都在才算；只有一個不算；指紋的冒號換成 "-"
    #[test]
    fn cache_hit_needs_both_outputs() {
        let d = temp_dir("cache");
        let fp = "12345:00ff00ff00ff00ff";
        assert!(cached_outputs(&d, fp).is_none());
        let (v, b) = output_paths(&d, fp);
        assert_eq!(v.file_name().unwrap().to_string_lossy(), "12345-00ff00ff00ff00ff-vocals.wav");
        std::fs::write(&v, b"x").unwrap();
        assert!(cached_outputs(&d, fp).is_none(), "只有人聲不算完整");
        std::fs::write(&b, b"x").unwrap();
        assert_eq!(cached_outputs(&d, fp), Some((v, b)));
        let _ = std::fs::remove_dir_all(&d);
    }

    /// RawReader：隨機讀取交錯 f32 立體聲；超出檔尾的部分補 0
    #[test]
    fn raw_reader_seeks_and_pads() {
        let d = temp_dir("raw");
        let f = d.join("a.raw");
        let mut bytes = vec![];
        for i in 0..10 {
            bytes.extend_from_slice(&(i as f32).to_le_bytes());
            bytes.extend_from_slice(&(-(i as f32)).to_le_bytes());
        }
        std::fs::write(&f, &bytes).unwrap();
        let r = RawReader::open(&f).unwrap();
        let blk = r.read(3, 5);
        assert_eq!(blk, vec![vec![3.0, 4.0], vec![-3.0, -4.0]]);
        let tail = r.read(9, 12);
        assert_eq!(tail[0], vec![9.0, 0.0, 0.0]);
        assert_eq!(scan_peak(&f, &AtomicBool::new(false)).unwrap(), 9.0);
        let _ = std::fs::remove_dir_all(&d);
    }
}
