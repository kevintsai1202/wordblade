# 10/27 實測③路線 B（ffmpeg 退路）的執行腳本：跑 3D 區段的畫格往返（Rust ffmpeg 管線＋Tauri IPC＋three.js），量時間。
# 用法（PowerShell 7，repo 根目錄）：
#   pwsh spikes/ipc-bench/run-ipc.ps1 -Build                       # 建置（vite build＋tauri build --debug）；建置輸出在 logs/ipc-bench-build.log
#   pwsh spikes/ipc-bench/run-ipc.ps1 -Frames 90 -Snap -Tag smoke  # （加 -Release 用 release 版）驗證流程：只跑 90 格、存抽樣畫格 PNG
#   pwsh spikes/ipc-bench/run-ipc.ps1 -Tag full                    # 完整 60 秒（1800 格），逐格串行
#   pwsh spikes/ipc-bench/run-ipc.ps1 -Pipe -Tag full-pipe         # 管線化（預取下一格、送格不等回應）
# 結果：output/result-<Tag>.json；編碼出來的 3D 區段在 output/seg-3d.mp4，跑完會用 ffprobe 驗長度、抽一格存成 output/seg-3d-mid.png。
# 跑之前讓機器閒置（不要同時編譯或跑其他重工作）。
param(
    [switch]$Build,
    [switch]$Pipe,
    [switch]$Release,   # 用 release 版 exe（需先 npx tauri build --no-bundle）；預設 debug 版
    [switch]$Snap,
    [int]$Frames = 0,
    [double]$T0 = 60,
    [double]$Dur = 60,
    [string]$Encoder = 'h264_qsv',
    [string]$Tag = 'run',
    [int]$TimeoutMinutes = 20
)

$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Resolve-Path (Join-Path $here '..\..')
$out = Join-Path $here 'output'
New-Item -ItemType Directory -Force $out | Out-Null
# 和正式 app 共用編好的相依套件
$env:CARGO_TARGET_DIR = Join-Path $root 'src-tauri\target'

if ($Build) {
    Push-Location $here
    npx vite build 2>&1 | Select-Object -Last 3
    npx tauri build --debug --no-bundle 2>&1 | Tee-Object -FilePath (Join-Path $root 'logs\ipc-bench-build.log') | Select-Object -Last 3
    $buildExit = $LASTEXITCODE
    Pop-Location
    if ($buildExit -ne 0) { throw '建置失敗，見 logs\ipc-bench-build.log' }
}

# 量測參數用環境變數傳給 exe（Rust 的 fb_config 讀）
$env:IPCB_SRC = Join-Path $root 'samples\bench-11min.mp4'
$env:IPCB_OUT = $out
$env:IPCB_T0 = "$T0"
$env:IPCB_DUR = "$Dur"
$env:IPCB_FRAMES = "$Frames"
$env:IPCB_PIPE = $(if ($Pipe) { '1' } else { '0' })
$env:IPCB_SNAP = $(if ($Snap) { '1' } else { '0' })
$env:IPCB_ENCODER = $Encoder
$env:IPCB_TAG = $Tag

$result = Join-Path $out "result-$Tag.json"
Remove-Item $result -ErrorAction SilentlyContinue
$app = Start-Process (Join-Path $env:CARGO_TARGET_DIR ($(if ($Release) { 'release' } else { 'debug' }) + '\ipc-bench.exe')) -PassThru
try {
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ((Get-Date) -lt $deadline -and -not (Test-Path $result)) { Start-Sleep -Seconds 2 }
    if (-not (Test-Path $result)) { throw "逾時，沒有結果檔 $result" }
}
finally {
    Start-Sleep -Seconds 1
    Stop-Process -Id $app.Id -ErrorAction SilentlyContinue
}

Get-Content $result -Raw

# 驗證輸出：長度、格數、抽中間一格
$seg = Join-Path $out 'seg-3d.mp4'
ffprobe -v error -count_frames -select_streams v:0 -show_entries stream=codec_name,width,height,nb_read_frames,duration -of compact $seg
ffmpeg -v error -y -ss ([Math]::Min($Dur, $(if ($Frames -gt 0) { $Frames / 30 } else { $Dur })) / 2) -i $seg -frames:v 1 (Join-Path $out 'seg-3d-mid.png')
