# 10/27 實測⑤⑥：在 Tauri（WebView2）正式網址 http://tauri.localhost 下檢查 Origin、麥克風、WebCodecs。
# 步驟：
#   1. 建置把檢查頁打包進去的除錯版（會覆蓋 src-tauri/target/debug/wordblade.exe，之後正常 build 會蓋回來）
#      pnpm tauri build --debug --no-bundle --config '{"build":{"frontendDist":"../spikes/tauri-env/dist","beforeBuildCommand":""}}'
#   2. pwsh spikes/tauri-env/run-check.ps1
# 結果：spikes/tauri-env/RESULT.json（requests 裡每個請求的 Origin、report 裡頁面回報的結果）
param([int]$TimeoutSeconds = 40)

$ErrorActionPreference = 'Stop'
$root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$result = Join-Path $PSScriptRoot 'RESULT.json'
Remove-Item $result -ErrorAction SilentlyContinue

# 啟動回聲伺服器與 app
$echo = Start-Process node -ArgumentList (Join-Path $PSScriptRoot 'echo-server.mjs') -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 1
$app = Start-Process (Join-Path $root 'src-tauri\target\debug\wordblade.exe') -PassThru

try {
    # 等頁面回報（麥克風若跳出權限詢問，需要手動按允許）
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 1
        if ((Test-Path $result) -and ((Get-Content $result -Raw | ConvertFrom-Json).report)) { break }
    }
}
finally {
    Stop-Process -Id $app.Id -ErrorAction SilentlyContinue
    Stop-Process -Id $echo.Id -ErrorAction SilentlyContinue
}

if (Test-Path $result) { Get-Content $result -Raw } else { Write-Output '沒有收到任何請求' }
