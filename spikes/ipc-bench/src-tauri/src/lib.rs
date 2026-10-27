// 10/27 實測③路線 B（ffmpeg 退路）：3D 區段的畫格由 Rust 的兩個 ffmpeg 行程供應與接收，
// 中間經 Tauri IPC 到 WebView 算 three.js（spec §5.4 退路、§5.7）。
//   解碼端 ffmpeg：解兩路（主畫面＋30 秒的子母畫面）、scale＋overlay，輸出 rgba rawvideo 到 stdout
//   編碼端 ffmpeg：從 stdin 收 rgba rawvideo，h264_qsv 8 Mbps 編成 seg.mp4
//   fb_next：取一格（8,294,400 位元組，二進位回傳）；fb_push：收一格寫進編碼端；fb_open／fb_close：開關兩個行程
// 兩端各有一條背景執行緒與深度 QUEUE_DEPTH 的佇列，讓 ffmpeg 的解碼／編碼和前端的算繪重疊（實際實作也會這樣做）；
// 另記錄 fb_next／fb_push 在佇列上等待的時間，才分得出「純 IPC」和「等 ffmpeg」。
use std::fs::File;
use std::io::{Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::Instant;

use tauri::ipc::{InvokeBody, Request, Response};
use tauri::State;

/// 一格 1920×1080 RGBA 的位元組數
const FRAME_BYTES: usize = 1920 * 1080 * 4;
/// 兩端佇列的深度（格）
const QUEUE_DEPTH: usize = 4;
/// Windows：不要為 ffmpeg 開主控台視窗
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 一次 3D 區段的工作階段：兩個 ffmpeg 行程、兩條背景執行緒與佇列
struct Session {
    decoder: Child,
    encoder: Child,
    reader: Option<JoinHandle<()>>,
    writer: Option<JoinHandle<()>>,
    opened_at: Instant,
}

/// 全域狀態：目前的工作階段與統計（奈秒累計）
#[derive(Default)]
struct AppState {
    session: Mutex<Option<Session>>,
    /// 解碼端讀取執行緒送來的畫格（獨立一把鎖：fb_next 等畫格時不能擋住 fb_push）
    frames_rx: Mutex<Option<Receiver<Vec<u8>>>>,
    /// 送往編碼端寫入執行緒的畫格
    push_tx: Mutex<Option<SyncSender<Vec<u8>>>>,
    /// fb_next 在佇列上等解碼端的總時間
    next_wait_ns: AtomicU64,
    /// fb_next 的總呼叫時間（含等待）
    next_total_ns: AtomicU64,
    /// fb_push 在佇列上等編碼端（佇列滿）的總時間
    push_wait_ns: AtomicU64,
    /// fb_push 的總呼叫時間（含複製與等待）
    push_total_ns: AtomicU64,
    next_calls: AtomicU64,
    push_calls: AtomicU64,
}

/// 量測設定（從環境變數來，由 run-ipc.ps1 設定）
#[derive(serde::Serialize)]
struct Config {
    /// 3D 區段在來源上的起點（秒）與長度（秒）
    t0: f64,
    dur: f64,
    /// 最多處理幾格（0＝全部）
    frames: u64,
    /// 是否用管線化迴圈（下一格預取、送格不等回應）
    pipe: bool,
    /// 是否存抽樣畫格 PNG（驗證流程用，會拖慢）
    snap: bool,
    /// 結果標籤（檔名用）
    tag: String,
}

/// 讀環境變數，沒有就用預設值
fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).unwrap_or_else(|_| default.to_string())
}

/// 輸出資料夾（結果、seg.mp4、ffmpeg 記錄都放這裡）
fn out_dir() -> String {
    env_or("IPCB_OUT", ".")
}

/// 回傳這次量測的設定
#[tauri::command]
fn fb_config() -> Config {
    Config {
        t0: env_or("IPCB_T0", "60").parse().unwrap_or(60.0),
        dur: env_or("IPCB_DUR", "60").parse().unwrap_or(60.0),
        frames: env_or("IPCB_FRAMES", "0").parse().unwrap_or(0),
        pipe: env_or("IPCB_PIPE", "0") == "1",
        snap: env_or("IPCB_SNAP", "0") == "1",
        tag: env_or("IPCB_TAG", "run"),
    }
}

/// 啟動解碼端與編碼端兩個 ffmpeg，並開兩條背景執行緒（讀解碼端 stdout、寫編碼端 stdin）
#[tauri::command]
async fn fb_open(t0: f64, dur: f64, state: State<'_, AppState>) -> Result<(), String> {
    let bench = env_or("IPCB_SRC", "bench-11min.mp4");
    let out = out_dir();
    let encoder_name = env_or("IPCB_ENCODER", "h264_qsv");
    let (t0s, durs, t30s) = (format!("{t0:.3}"), format!("{dur:.3}"), format!("{:.3}", t0 + 30.0));

    let mut decoder = Command::new("ffmpeg")
        .args(["-v", "error", "-y", "-ss", &t0s, "-t", &durs, "-i", &bench, "-ss", &t30s, "-t", &durs, "-i", &bench])
        .args(["-filter_complex", "[1:v]scale=480:270[p];[0:v][p]overlay=1400:40", "-an", "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(File::create(format!("{out}/ffmpeg-dec.log")).map_err(|e| e.to_string())?)
        .creation_flags_windows()
        .spawn()
        .map_err(|e| format!("啟動解碼端 ffmpeg 失敗：{e}"))?;
    let mut encoder = Command::new("ffmpeg")
        .args(["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "1920x1080", "-r", "30", "-i", "pipe:0"])
        .args(["-c:v", &encoder_name, "-b:v", "8M", "-g", "60", &format!("{out}/seg-3d.mp4")])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(File::create(format!("{out}/ffmpeg-enc.log")).map_err(|e| e.to_string())?)
        .creation_flags_windows()
        .spawn()
        .map_err(|e| format!("啟動編碼端 ffmpeg 失敗：{e}"))?;

    // 讀取執行緒：從解碼端 stdout 讀滿一格就送進佇列（佇列滿了會擋住，ffmpeg 也跟著被擋）
    let mut dec_stdout = decoder.stdout.take().ok_or("解碼端沒有 stdout")?;
    let (frames_tx, frames_rx) = sync_channel::<Vec<u8>>(QUEUE_DEPTH);
    let reader = std::thread::spawn(move || {
        loop {
            let mut buf = vec![0u8; FRAME_BYTES];
            if dec_stdout.read_exact(&mut buf).is_err() || frames_tx.send(buf).is_err() {
                break; // 讀到結尾（EOF）或前端不收了
            }
        }
    });
    // 寫入執行緒：從佇列取一格寫進編碼端 stdin；佇列關閉後關掉 stdin，ffmpeg 就收尾
    let mut enc_stdin = encoder.stdin.take().ok_or("編碼端沒有 stdin")?;
    let (push_tx, push_rx) = sync_channel::<Vec<u8>>(QUEUE_DEPTH);
    let writer = std::thread::spawn(move || {
        for frame in push_rx {
            if enc_stdin.write_all(&frame).is_err() {
                break;
            }
        }
    });

    for counter in [&state.next_wait_ns, &state.next_total_ns, &state.push_wait_ns, &state.push_total_ns, &state.next_calls, &state.push_calls] {
        counter.store(0, Ordering::Relaxed);
    }
    *state.frames_rx.lock().unwrap() = Some(frames_rx);
    *state.push_tx.lock().unwrap() = Some(push_tx);
    *state.session.lock().unwrap() = Some(Session {
        decoder,
        encoder,
        reader: Some(reader),
        writer: Some(writer),
        opened_at: Instant::now(),
    });
    Ok(())
}

/// 取下一格（rgba，8,294,400 位元組）；以 `tauri::ipc::Response` 二進位回傳，不經 JSON
#[tauri::command]
async fn fb_next(state: State<'_, AppState>) -> Result<Response, String> {
    let started = Instant::now();
    let frame = {
        let guard = state.frames_rx.lock().unwrap();
        let rx = guard.as_ref().ok_or("尚未 fb_open")?;
        let waited = Instant::now();
        let frame = rx.recv().map_err(|_| "解碼端已結束（沒有更多畫格）".to_string());
        state.next_wait_ns.fetch_add(waited.elapsed().as_nanos() as u64, Ordering::Relaxed);
        frame?
    };
    state.next_total_ns.fetch_add(started.elapsed().as_nanos() as u64, Ordering::Relaxed);
    state.next_calls.fetch_add(1, Ordering::Relaxed);
    Ok(Response::new(frame))
}

/// 收一格（請求本體是 raw bytes，`InvokeBody::Raw`），寫進編碼端的佇列
#[tauri::command]
async fn fb_push(request: Request<'_>, state: State<'_, AppState>) -> Result<(), String> {
    let started = Instant::now();
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("fb_push 要用 raw body（Uint8Array）".into());
    };
    if bytes.len() != FRAME_BYTES {
        return Err(format!("畫格大小不對：{}（應為 {FRAME_BYTES}）", bytes.len()));
    }
    let tx = state.push_tx.lock().unwrap().clone().ok_or("尚未 fb_open 或已 fb_close")?;
    let frame = bytes.to_vec(); // 請求本體是借用的，要複製一份交給寫入執行緒
    let waited = Instant::now();
    tx.send(frame).map_err(|_| "編碼端已結束".to_string())?;
    state.push_wait_ns.fetch_add(waited.elapsed().as_nanos() as u64, Ordering::Relaxed);
    state.push_total_ns.fetch_add(started.elapsed().as_nanos() as u64, Ordering::Relaxed);
    state.push_calls.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

/// 關閉編碼端 stdin、等兩個 ffmpeg 結束，回傳統計（JSON 字串）
#[tauri::command]
async fn fb_close(state: State<'_, AppState>) -> Result<String, String> {
    let mut session = state.session.lock().unwrap().take().ok_or("沒有進行中的工作階段")?;
    drop(state.push_tx.lock().unwrap().take()); // 佇列關閉 → 寫入執行緒結束 → stdin 關閉
    if let Some(writer) = session.writer.take() {
        let _ = writer.join();
    }
    let enc_status = session.encoder.wait().map_err(|e| e.to_string())?;
    // 解碼端有 -t 會自己結束；還沒結束（前端少取了格）就殺掉，避免卡住
    drop(state.frames_rx.lock().unwrap().take());
    let _ = session.decoder.kill();
    let dec_status = session.decoder.wait().map_err(|e| e.to_string())?;
    if let Some(reader) = session.reader.take() {
        let _ = reader.join();
    }
    let ms = |ns: &AtomicU64| ns.load(Ordering::Relaxed) as f64 / 1e6;
    Ok(serde_json::json!({
        "encoderExit": enc_status.code(),
        "decoderExit": dec_status.code(),
        "sessionMs": session.opened_at.elapsed().as_secs_f64() * 1e3,
        "nextCalls": state.next_calls.load(Ordering::Relaxed),
        "nextTotalMs": ms(&state.next_total_ns),
        "nextQueueWaitMs": ms(&state.next_wait_ns),
        "pushCalls": state.push_calls.load(Ordering::Relaxed),
        "pushTotalMs": ms(&state.push_total_ns),
        "pushQueueWaitMs": ms(&state.push_wait_ns),
    })
    .to_string())
}

/// 把前端送來的位元組存成輸出資料夾裡的檔案（檔名在 header `x-name`；抽樣畫格 PNG 用）
#[tauri::command]
async fn fb_save(request: Request<'_>) -> Result<(), String> {
    let name = request
        .headers()
        .get("x-name")
        .and_then(|v| v.to_str().ok())
        .ok_or("缺少 x-name header")?
        .replace(['/', '\\'], "_");
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("fb_save 要用 raw body".into());
    };
    std::fs::write(format!("{}/{name}", out_dir()), bytes).map_err(|e| e.to_string())
}

/// 寫結果檔（JSON 字串）
#[tauri::command]
fn fb_report(json: String, tag: String) -> Result<(), String> {
    std::fs::write(format!("{}/result-{tag}.json", out_dir()), json).map_err(|e| e.to_string())
}

/// 結束程式（量測完由前端呼叫，run-ipc.ps1 以結果檔出現判斷完成）
#[tauri::command]
fn fb_exit() {
    std::process::exit(0);
}

/// 讓 `Command` 在 Windows 上不開主控台視窗的小擴充（其他平台不做事）
trait NoWindow {
    fn creation_flags_windows(&mut self) -> &mut Self;
}
impl NoWindow for Command {
    #[cfg(windows)]
    fn creation_flags_windows(&mut self) -> &mut Self {
        use std::os::windows::process::CommandExt;
        self.creation_flags(CREATE_NO_WINDOW)
    }
    #[cfg(not(windows))]
    fn creation_flags_windows(&mut self) -> &mut Self {
        self
    }
}

/// 啟動 Tauri 應用程式
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![fb_config, fb_open, fb_next, fb_push, fb_close, fb_save, fb_report, fb_exit])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
