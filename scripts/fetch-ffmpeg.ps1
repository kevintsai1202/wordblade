# 下載打包用的 LGPL 版 ffmpeg（BtbN 建置，shared 版：exe＋DLL），放到 src-tauri/resources/ffmpeg/（不進版控）。
# spec §3：打包 LGPL 版、不含 libx264；代理檔依序試編 h264_qsv → h264_nvenc → h264_amf → h264_mf。
# 版本釘在固定的 autobuild 標籤；BtbN 會清掉舊標籤，下載失敗時改 -Tag／-Asset 換成新的（gh api repos/BtbN/FFmpeg-Builds/releases 查）。
#
# 用法（repo 根目錄，PowerShell 7）：
#   pwsh scripts/fetch-ffmpeg.ps1           下載、解壓、只留 ffmpeg.exe／ffprobe.exe／DLL／授權，再驗證編碼器
#   pwsh scripts/fetch-ffmpeg.ps1 -Force    已經有了也重新下載
# 紀錄：logs/fetch-ffmpeg.log
param(
  [string]$Tag = 'autobuild-2026-10-26-14-25',
  [string]$Asset = 'ffmpeg-n9.0.2-36-g6882969ce9-win64-lgpl-shared-9.0.zip',
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

$Root = Split-Path $PSScriptRoot -Parent
$Dest = Join-Path $Root 'src-tauri/resources/ffmpeg'                       # 打包進安裝檔的資料夾
$Work = Join-Path ([IO.Path]::GetTempPath()) 'wordblade-fetch-ffmpeg'      # 下載與解壓的暫存處（repo 之外）
$Log = Join-Path $Root 'logs/fetch-ffmpeg.log'
New-Item -ItemType Directory -Force (Split-Path $Log) | Out-Null

<# 寫一行紀錄到畫面與 log 檔 #>
function Write-Log([string]$Message) {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $Message"
  Write-Host $line
  Add-Content -Path $Log -Value $line -Encoding utf8
}

<# 用 1 格黑畫面實際試編，回傳這個編碼器能不能用（只看 -encoders 清單不準，spec §3） #>
function Test-Encoder([string]$Ffmpeg, [string]$Encoder) {
  if ($Encoder -eq 'aac') {
    & $Ffmpeg -hide_banner -loglevel error -f lavfi -i anullsrc=r=48000:cl=stereo -t 0.1 -c:a aac -f null - 2>$null
  } else {
    & $Ffmpeg -hide_banner -loglevel error -f lavfi -i color=c=black:s=320x240:d=0.1 -frames:v 1 -c:v $Encoder -f null - 2>$null
  }
  return $LASTEXITCODE -eq 0
}

Write-Log "== fetch-ffmpeg 開始（$Tag / $Asset）"
$ffmpeg = Join-Path $Dest 'bin/ffmpeg.exe'
if ((Test-Path $ffmpeg) -and -not $Force) {
  Write-Log "已經有 $ffmpeg，略過下載（要重抓加 -Force）"
} else {
  if ((Split-Path $Work -Leaf) -ne 'wordblade-fetch-ffmpeg') { throw "暫存路徑異常：$Work" }
  if (Test-Path $Work) { Remove-Item $Work -Recurse -Force }
  New-Item -ItemType Directory -Force $Work | Out-Null
  $zip = Join-Path $Work $Asset
  $url = "https://github.com/BtbN/FFmpeg-Builds/releases/download/$Tag/$Asset"
  Write-Log "下載 $url"
  Invoke-WebRequest $url -OutFile $zip
  Write-Log "SHA256 $((Get-FileHash $zip -Algorithm SHA256).Hash)"
  Expand-Archive $zip -DestinationPath $Work
  $top = Get-ChildItem $Work -Directory | Select-Object -First 1
  if (Test-Path $Dest) { Remove-Item $Dest -Recurse -Force }
  New-Item -ItemType Directory -Force (Join-Path $Dest 'bin') | Out-Null
  # 只留執行要用的：ffmpeg.exe、ffprobe.exe、DLL；ffplay 不打包
  Get-ChildItem (Join-Path $top.FullName 'bin') -File | Where-Object { $_.Name -ne 'ffplay.exe' } |
    Copy-Item -Destination (Join-Path $Dest 'bin')
  Copy-Item (Join-Path $top.FullName 'LICENSE.txt') $Dest
  Set-Content (Join-Path $Dest 'SOURCE.txt') -Encoding utf8 -Value @(
    "BtbN FFmpeg-Builds（LGPL shared），https://github.com/BtbN/FFmpeg-Builds",
    "release tag: $Tag",
    "asset: $Asset",
    "FFmpeg 原始碼：https://github.com/FFmpeg/FFmpeg（版本見 ffmpeg -version）"
  )
  Remove-Item $Work -Recurse -Force
}

$mb = [math]::Round(((Get-ChildItem $Dest -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 1)
Write-Log "資料夾：$Dest（${mb} MB）"
Write-Log ((& $ffmpeg -hide_banner -version | Select-Object -First 1))
# 授權檢查：LGPL 建置不該有 --enable-gpl
if ((& $ffmpeg -hide_banner -buildconf) -match 'enable-gpl') { throw '這份 ffmpeg 是 GPL 建置，不能打包' }
foreach ($enc in 'h264_qsv', 'h264_nvenc', 'h264_amf', 'h264_mf', 'aac') {
  Write-Log ("編碼器 {0}：{1}" -f $enc, $(if (Test-Encoder $ffmpeg $enc) { '可用' } else { '不可用' }))
}
Write-Log '== 完成'
