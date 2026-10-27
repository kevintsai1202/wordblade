# 檢查本機 ffmpeg 的 H.264 編碼器實際能不能用（10/27 實測 ④）
# 用法：pwsh spikes/ffmpeg-encoders/check-encoders.ps1 [-Ffmpeg <ffmpeg 路徑>]
# 每個編碼器用 2 秒的測試畫面實際編一次，結果寫到同目錄的 RESULT.md
param([string]$Ffmpeg = 'ffmpeg')

$ErrorActionPreference = 'Stop'
# 要測的編碼器：硬體（Intel／AMD／NVIDIA）、Windows 內建 Media Foundation、軟體
$encoders = 'h264_qsv', 'h264_mf', 'h264_amf', 'h264_nvenc', 'libx264', 'libopenh264'

# 機器資訊：顯卡與 CPU
$gpu = (Get-CimInstance Win32_VideoController | ForEach-Object { "$($_.Name)（驅動 $($_.DriverVersion)）" }) -join '；'
$cpu = (Get-CimInstance Win32_Processor).Name
$version = (& $Ffmpeg -hide_banner -version | Select-Object -First 1)

$rows = foreach ($e in $encoders) {
    # 實際編碼 2 秒 720p 測試畫面，丟到 null 輸出；成功與否看結束碼
    & $Ffmpeg -v error -f lavfi -i 'testsrc2=s=1280x720:r=30' -t 2 -c:v $e -f null - 2>$null | Out-Null
    $ok = $LASTEXITCODE -eq 0
    "| ``$e`` | $(if ($ok) { '可用' } else { '不可用' }) |"
}

@"
# ffmpeg H.264 編碼器實測

- 日期：$(Get-Date -Format 'yyyy-MM-dd HH:mm')
- ffmpeg：$version
- CPU：$cpu
- 顯卡：$gpu

| 編碼器 | 結果 |
| --- | --- |
$($rows -join "`n")
"@ | Set-Content -Encoding utf8 (Join-Path $PSScriptRoot 'RESULT.md')

Get-Content (Join-Path $PSScriptRoot 'RESULT.md')
