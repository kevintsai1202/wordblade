# 10/27 實測②的 Tauri（WebView2）版：同一個量測頁在 WordBlade 的 Tauri 外殼裡跑，結果經回聲伺服器寫到 spikes/tauri-env/RESULT.json。
# 用法（repo 根目錄）：pwsh spikes/export-bench/run-tauri.ps1 [-Seconds 20]
# 含 3D 區段（實測③）：-Scene3d（預設 60～120 秒；-S3d '5,15' 改起訖）、-Seg（對照組：不開 3D 但量區段耗時）、-Snap（存抽樣畫格 PNG 到 output/）、
# -Tag 名稱（結果另存到 output/results-tauri-<名稱>.json，並把抽樣畫格存成 output/snap-tauri-<名稱>-*.png；跑之前請先備份 spikes/tauri-env/RESULT.json，它會被覆蓋）
# 會先建置一個視窗網址指向量測頁的除錯版（覆蓋 src-tauri/target/debug/wordblade.exe）；跑之前讓機器閒置。
param([int]$Seconds = 0, [int]$TimeoutMinutes = 40, [switch]$Scene3d, [switch]$Seg, [switch]$Snap, [string]$S3d = '', [string]$Tag = '')

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$query = 'hw=prefer-hardware&report=1' + $(if ($Seconds -gt 0) { "&seconds=$Seconds" } else { '' })
if ($Scene3d) { $query += '&scene3d=1' }
if ($Seg) { $query += '&seg=1' }
if ($Snap) { $query += '&snap=1' }
if ($S3d) { $a, $b = $S3d.Split(','); $query += "&s3dStart=$a&s3dEnd=$b" }
$url = "http://localhost:5199/?$query"

# 1. 建置：主視窗直接開量測頁（Vite 開發伺服器）
Push-Location $root
# 設定寫成檔案再傳路徑：網址裡的 & 經過 cmd 會被切斷
$configFile = Join-Path $root 'logs\export-bench-tauri.conf.json'
@{ build = @{ beforeBuildCommand = '' }; app = @{ windows = @(@{ title = 'export bench'; url = $url; width = 800; height = 600 }) } } |
    ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8NoBOM $configFile
pnpm tauri build --debug --no-bundle --config $configFile 2>&1 | Tee-Object -FilePath (Join-Path $root 'logs\export-bench-tauri-build.log') | Select-Object -Last 2
$buildExit = $LASTEXITCODE
Pop-Location
if ($buildExit -ne 0) { throw "Tauri 建置失敗，見 logs\export-bench-tauri-build.log" }

# 2. 啟動回聲伺服器、量測頁的 Vite 伺服器、app
$result = Join-Path $root 'spikes\tauri-env\RESULT.json'
Remove-Item $result -ErrorAction SilentlyContinue
$echo = Start-Process node -ArgumentList (Join-Path $root 'spikes\tauri-env\echo-server.mjs') -PassThru -WindowStyle Hidden
# 直接用 node 跑 vite（Start-Process 叫 npx.cmd 不可靠）；等埠開好再啟動 app
$vite = Start-Process node -ArgumentList 'node_modules/vite/bin/vite.js', '--port', '5199', '--strictPort' -WorkingDirectory $PSScriptRoot -PassThru -WindowStyle Hidden
$ready = $false
foreach ($i in 1..30) {
    Start-Sleep -Seconds 1
    try { Invoke-WebRequest 'http://localhost:5199/' -UseBasicParsing -TimeoutSec 2 | Out-Null; $ready = $true; break } catch { }
}
if (-not $ready) { throw 'Vite 伺服器 30 秒內沒有起來' }
$app = Start-Process (Join-Path $root 'src-tauri\target\debug\wordblade.exe') -PassThru

try {
    $deadline = (Get-Date).AddMinutes($TimeoutMinutes)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 5
        if ((Test-Path $result) -and ((Get-Content $result -Raw | ConvertFrom-Json).report)) { break }
    }
}
finally {
    Stop-Process -Id $app.Id -ErrorAction SilentlyContinue
    Stop-Process -Id $echo.Id -ErrorAction SilentlyContinue
    taskkill /PID $vite.Id /T /F | Out-Null
}

$report = (Get-Content $result -Raw | ConvertFrom-Json).report
if ($Tag) {
    # 抽樣畫格另存成 PNG；結果 JSON 裡不留 data URL
    $outDir = Join-Path $PSScriptRoot 'output'
    foreach ($shot in @($report.snapshots)) {
        if ($shot.dataUrl) { [IO.File]::WriteAllBytes((Join-Path $outDir "snap-tauri-$Tag-$($shot.name).png"), [Convert]::FromBase64String(($shot.dataUrl -split ',')[1])) }
    }
    if ($report.snapshots) { $report.snapshots = @($report.snapshots | ForEach-Object { $_.name }) }
    $report | ConvertTo-Json -Depth 6 | Set-Content -Encoding utf8NoBOM (Join-Path $outDir "results-tauri-$Tag.json")
}
$report | ConvertTo-Json -Depth 6
