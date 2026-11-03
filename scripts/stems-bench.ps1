# 長音訊聲音分離實測（2026-11-02）：把 e2e 的 30 秒素材接成 N 分鐘，跑 app 的分離函式（src-tauri/src/stems 的 bench_long_audio，release），
# 同時每 0.5 秒量測試程式的記憶體（工作集）峰值。結果印在最後，log 寫到 logs/stems-bench.log。
# 注意：會用 cargo 編譯 src-tauri（正在跑的 pnpm tauri dev 會被重編中斷）。
param(
  [int]$Minutes = 10,
  [string]$Model = "$env:LOCALAPPDATA\Temp\wb-empty-models\Kim_Vocal_2.onnx"
)
$ErrorActionPreference = "Stop"
$root = Split-Path $PSScriptRoot -Parent
$raw = Join-Path $env:TEMP "wb-bench-$Minutes.raw"
$log = Join-Path $root "logs\stems-bench.log"
New-Item -ItemType Directory -Force (Join-Path $root "logs") | Out-Null

# 1. 產生 N 分鐘的 44.1 kHz 立體聲 f32le（speech30.mp4 重複播放）
$loops = [Math]::Ceiling($Minutes * 60 / 30) - 1
ffmpeg -y -v error -stream_loop $loops -i (Join-Path $root "e2e\fixtures\speech30.mp4") -t ($Minutes * 60) -vn -ac 2 -ar 44100 -f f32le $raw
"raw: $raw ($([Math]::Round((Get-Item $raw).Length / 1MB)) MB)" | Tee-Object -FilePath $log

# 2. 跑測試（背景），量記憶體峰值
$env:WB_BENCH_MODEL = $Model
$env:WB_BENCH_RAW = $raw
Push-Location (Join-Path $root "src-tauri")
cargo test --release --lib bench_long_audio --no-run 2>&1 | Select-Object -Last 3 | Tee-Object -FilePath $log -Append
$job = Start-Process cargo -ArgumentList "test", "--release", "--lib", "bench_long_audio", "--", "--ignored", "--nocapture" -NoNewWindow -PassThru -RedirectStandardError "$log.err" -RedirectStandardOutput "$log.out"
$peak = 0
while (-not $job.HasExited) {
  Get-Process | Where-Object { $_.ProcessName -like "wordblade_lib-*" } | ForEach-Object { if ($_.WorkingSet64 -gt $peak) { $peak = $_.WorkingSet64 } }
  Start-Sleep -Milliseconds 500
}
Pop-Location
Get-Content "$log.err" | Select-String "BENCH|progress|panicked|error" | Tee-Object -FilePath $log -Append
"peak working set: $([Math]::Round($peak / 1MB)) MB" | Tee-Object -FilePath $log -Append
Remove-Item $raw
