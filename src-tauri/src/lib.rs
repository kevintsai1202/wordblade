// WordBlade 桌面版的 Rust 指令層（spec §3）：ffmpeg／ffprobe（代理檔、縮圖、音量包絡）、之後放檔案讀寫、背景工作、聲音分離。

mod export;
mod generated;
mod media;
mod project;
mod recorder;
mod stems;

use tauri::webview::{PageLoadEvent, PermissionKind, PermissionResponse};

/// 啟動 Tauri 應用程式
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(export::ExportFiles::default())
        .invoke_handler(tauri::generate_handler![
            media::probe_media,
            media::make_proxy,
            media::media_envelope,
            media::media_thumbnail,
            media::media_tools,
            media::evict_proxy,
            media::find_samples_dir,
            media::find_sample_dir,
            media::asr_pcm,
            media::thumbs_status,
            project::project_create,
            project::project_write,
            project::project_read,
            project::project_data_write,
            project::project_data_read,
            project::media_fingerprint,
            project::media_locate,
            media::thumbs_make,
            export::export_open,
            export::export_write,
            export::export_close,
            export::export_abort,
            export::write_text_file,
            generated::write_generated,
            recorder::recorder_start,
            recorder::recorder_stop,
            stems::separate_vocals,
            stems::separate_cancel,
            stems::separate_evict
        ])
        // 麥克風（重配錄音，§5.18）：WebView2 預設會跳權限詢問且卡住 getUserMedia，這裡直接允許；
        // 其他權限（相機、定位…）照平台預設。Windows「隱私權 > 麥克風 > 允許桌面應用程式存取」關掉時仍會被拒。
        .on_permission_request(|_, kind| match kind {
            PermissionKind::Microphone => PermissionResponse::Allow,
            _ => PermissionResponse::Default,
        })
        .setup(|app| {
            // 啟動時在背景清理代理檔快取（30 天沒用到的、中斷留下的暫存檔）
            if let Ok(dir) = media::proxy_dir(app.handle()) {
                std::thread::spawn(move || media::cleanup_proxies(&dir));
            }
            // 縮圖序列（D39）：快取資料夾放行給 asset 協定（預覽與時間軸直接讀 JPEG），並在背景清理 30 天沒用到的
            if let Ok(root) = media::thumbs_root(app.handle()) {
                use tauri::Manager;
                let _ = app.asset_protocol_scope().allow_directory(&root, true);
                std::thread::spawn(move || media::cleanup_thumbs(&root));
            }
            // AI 音效與配樂產生的 WAV（§5.15）：重開專案時預覽也讀得到
            if let Ok(dir) = generated::generated_dir(app.handle()) {
                use tauri::Manager;
                let _ = app.asset_protocol_scope().allow_directory(&dir, true);
            }
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // 自我檢查（scripts/desktop-selftest/run.ps1）：WORDBLADE_SELFTEST 是本機回報伺服器的網址。
            // 主頁第一次載入完成後改開 ?selftest=<網址>，頁面跑完檢查把結果送回去。一般使用不會設這個變數。
            // （不能在 setup 裡做：那時 webview 還是 about:blank）
            let Ok(server) = std::env::var("WORDBLADE_SELFTEST") else { return };
            let url = payload.url();
            if payload.event() != PageLoadEvent::Finished || url.scheme() == "about" || url.query_pairs().any(|(k, _)| k == "selftest") {
                return;
            }
            let mut next = url.clone();
            next.query_pairs_mut().append_pair("selftest", &server);
            let _ = webview.navigate(next);
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
