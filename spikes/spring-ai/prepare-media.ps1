# 產生 Spring AI 實測用的影片與關鍵格圖片（PowerShell 7）
# 規格對照 spec §5.11：480p、每秒 2 格、無聲。來源：samples/lecture-a.en.mp4（1080p30）
# 用法：pwsh -File spikes/spring-ai/prepare-media.ps1
$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$src = Join-Path $root 'samples\lecture-a.en.mp4'
$out = Join-Path $PSScriptRoot 'media'
New-Item -ItemType Directory -Force $out | Out-Null

# 30 秒（從 60 秒處起）與 10 秒兩支：兩點相減可扣掉固定的 prompt 成本，算出每格 token 數
foreach ($len in 30, 10) {
    ffmpeg -y -v error -ss 60 -t $len -i $src -an -vf "scale=-2:480" -r 2 `
        -c:v libx264 -preset veryfast -crf 28 -pix_fmt yuv420p (Join-Path $out "clip$len.mp4")
}

# 退路：每 3 秒一張關鍵格（480p JPEG），取 30 秒那段 → 10 張
$frames = Join-Path $out 'frames'
New-Item -ItemType Directory -Force $frames | Out-Null
ffmpeg -y -v error -ss 60 -t 30 -i $src -an -vf "fps=1/3,scale=-2:480" -q:v 4 (Join-Path $frames 'k%02d.jpg')

Get-ChildItem $out -Recurse -File | Select-Object FullName, Length
