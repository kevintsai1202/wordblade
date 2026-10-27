# 桌面版自我檢查：啟動 WordBlade（預設 debug 版，可指定安裝後的 exe），在 WebView2 裡檢查匯入與預覽的關鍵路徑。
# 檢查項目見 src/selftest.ts；結果寫到 logs/desktop-selftest.json 並印出。
#
# 用法（repo 根目錄，PowerShell 7）：
#   pnpm tauri build --debug --no-bundle                      先建 debug 版（src-tauri/target/debug/wordblade.exe）
#   pwsh scripts/desktop-selftest/run.ps1                     用 e2e/fixtures 與 samples/lecture-a.en.mp4（有的話）檢查
#   pwsh scripts/desktop-selftest/run.ps1 -Exe "<安裝目錄>\wordblade.exe" -Files a.mp4,b.mp3
param(
  [string]$Exe,
  [string[]]$Files,
  [int]$TimeoutSeconds = 300
)
$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
if (-not $Exe) { $Exe = Join-Path $Root 'src-tauri\target\debug\wordblade.exe' }
if (-not $Files) {
  $Files = @('talk.mp4', 'music.mp3', 'alpha.mov' | ForEach-Object { Join-Path $Root "e2e\fixtures\$_" })
  $sample = Join-Path $Root 'samples\lecture-a.en.mp4'
  if (Test-Path $sample) { $Files += $sample }
}
$Result = Join-Path $Root 'logs\desktop-selftest.json'
Remove-Item $Result -ErrorAction SilentlyContinue

$serverArgs = @((Join-Path $PSScriptRoot 'report-server.mjs')) + ($Files | ForEach-Object { '"{0}"' -f $_ })
$server = Start-Process node -ArgumentList $serverArgs -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 1
$env:WORDBLADE_SELFTEST = 'http://127.0.0.1:8788'
$app = Start-Process $Exe -PassThru
try {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline -and -not (Test-Path $Result)) { Start-Sleep -Seconds 2 }
} finally {
  Remove-Item Env:WORDBLADE_SELFTEST
  Stop-Process -Id $app.Id -ErrorAction SilentlyContinue
  Stop-Process -Id $server.Id -ErrorAction SilentlyContinue
}
if (-not (Test-Path $Result)) { throw "逾時：$TimeoutSeconds 秒內沒有收到回報" }
Get-Content $Result -Raw
