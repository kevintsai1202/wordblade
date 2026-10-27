# 驗證安裝檔：靜默安裝到暫存資料夾 → 對安裝後的 wordblade.exe 跑桌面版自我檢查（打包的 ffmpeg、代理檔、asset 協定、Web Audio）→ 解除安裝。
# 用法（repo 根目錄，PowerShell 7）：pnpm tauri build 之後執行 pwsh scripts/verify-installer.ps1
# 紀錄：logs/verify-installer.log；自我檢查結果：logs/desktop-selftest.json
param([string]$Installer)
$ErrorActionPreference = 'Stop'

$Root = Split-Path $PSScriptRoot -Parent
if (-not $Installer) { $Installer = Get-ChildItem (Join-Path $Root 'src-tauri/target/release/bundle/nsis/*-setup.exe') | Sort-Object LastWriteTime | Select-Object -Last 1 -ExpandProperty FullName }
$Dir = Join-Path ([IO.Path]::GetTempPath()) 'wordblade-install-test'   # 安裝位置（repo 之外）
$Log = Join-Path $Root 'logs/verify-installer.log'

<# 寫一行紀錄到畫面與 log 檔 #>
function Write-Log([string]$Message) {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $Message"
  Write-Host $line
  Add-Content -Path $Log -Value $line -Encoding utf8
}

Write-Log "== 安裝檔：$Installer（$([math]::Round((Get-Item $Installer).Length / 1MB, 1)) MB）"
if ((Split-Path $Dir -Leaf) -ne 'wordblade-install-test') { throw "安裝路徑異常：$Dir" }
if (Test-Path $Dir) { Remove-Item $Dir -Recurse -Force }
# NSIS 靜默安裝：/D= 必須放最後、不能加引號
$sw = [Diagnostics.Stopwatch]::StartNew()
Start-Process $Installer -ArgumentList '/S', "/D=$Dir" -Wait
Write-Log "安裝完成（$([math]::Round($sw.Elapsed.TotalSeconds, 1)) 秒）"
$exe = Join-Path $Dir 'wordblade.exe'
if (-not (Test-Path $exe)) { throw "找不到安裝後的 $exe" }
Write-Log ("安裝內容：{0}" -f ((Get-ChildItem $Dir -Recurse -File | ForEach-Object { $_.FullName.Substring($Dir.Length + 1) }) -join ', '))
try {
  & (Join-Path $PSScriptRoot 'desktop-selftest/run.ps1') -Exe $exe | Out-Null
  $report = Get-Content (Join-Path $Root 'logs/desktop-selftest.json') -Raw | ConvertFrom-Json
  Write-Log "ffmpeg：$($report.tools.ffmpeg)；編碼器：$($report.tools.encoder)"
  foreach ($f in $report.files) {
    Write-Log ("{0}：probe {1}、準備 {2} ms、asset {3}、畫面 {4}、聲音 {5}{6}" -f (Split-Path $f.path -Leaf), $f.probe.kind, $f.prepare.ms, $f.asset.status, $f.video.meanPixel, $f.audio.peakLevel, $(if ($f.error) { "、錯誤 $($f.error)" } else { '' }))
  }
} finally {
  $uninstaller = Join-Path $Dir 'uninstall.exe'
  if (Test-Path $uninstaller) { Start-Process $uninstaller -ArgumentList '/S' -Wait; Write-Log '已解除安裝' }
}
Write-Log '== 完成'
