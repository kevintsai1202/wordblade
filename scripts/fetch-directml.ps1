# 準備聲音分離（spec §5.14）要隨安裝檔附的 DirectML.dll：從 ort 建置時下載的 onnxruntime 套件副本，複製到 src-tauri/resources/directml/（不進版控，和 ffmpeg 一樣）。
# onnxruntime 已靜態連結進 wordblade.exe（Cargo 的 ort + directml 功能），但 DirectML 本身是獨立的 DLL，必須在 exe 旁邊；
# tauri.conf.json 的 bundle.resources 會把它放到安裝目錄根（和 wordblade.exe 同一層）。
# 為什麼不直接從 NuGet 下載：Microsoft.AI.DirectML 的 nupkg 約 200 MB（含各平台與符號檔），只為了 18.5 MB 的 DLL 不划算；
# ort 的 copy-dylibs 功能在每次建置時就會把正確版本的 DirectML.dll 放到 src-tauri/target/<profile>/，這裡直接拿來用，版本一定和 ort 相容。
# 開發時不需要這個檔：直接用 target/<profile>/ 裡 ort 複製的那份。但 tauri 打包與 cargo 建置會檢查 bundle.resources 的檔案存在，
# 所以新 clone 的 repo 要先跑一次 cargo build（或 pnpm tauri build）再跑這個腳本。
# 授權：DirectML.dll 是 Microsoft 專有授權（可隨應用程式散布，限 Windows），README 的 Third-party 區塊有列。
#
# 用法（repo 根目錄，PowerShell 7）：
#   pwsh scripts/fetch-directml.ps1           複製 DirectML.dll
#   pwsh scripts/fetch-directml.ps1 -Force    已經有了也重新複製
# 紀錄：logs/fetch-directml.log
param([switch]$Force)
$ErrorActionPreference = 'Stop'

$Root = Split-Path $PSScriptRoot -Parent
$Dest = Join-Path $Root 'src-tauri/resources/directml'    # 打包進安裝檔的資料夾
$Log = Join-Path $Root 'logs/fetch-directml.log'
New-Item -ItemType Directory -Force (Split-Path $Log) | Out-Null

<# 寫一行紀錄到畫面與 log 檔 #>
function Write-Log([string]$Message) {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $Message"
  Write-Host $line
  Add-Content -Path $Log -Value $line -Encoding utf8
}

$dll = Join-Path $Dest 'DirectML.dll'
if ((Test-Path $dll) -and -not $Force) { Write-Log "已經有 $dll，略過（-Force 重新複製）"; return }

# 找最新的一份：release 優先（版本相同，挑修改時間最新的即可）
$candidates = @('release', 'debug') | ForEach-Object { Join-Path $Root "src-tauri/target/$_/DirectML.dll" } | Where-Object { Test-Path $_ }
if (-not $candidates) { throw "找不到 src-tauri/target/<profile>/DirectML.dll：先在 src-tauri 跑一次 cargo build（ort 建置時會下載並複製它）" }
$source = $candidates | Sort-Object { (Get-Item $_).LastWriteTime } -Descending | Select-Object -First 1
New-Item -ItemType Directory -Force $Dest | Out-Null
Copy-Item $source $dll -Force
$info = (Get-Item $dll).VersionInfo
Write-Log "完成：$dll（$([math]::Round((Get-Item $dll).Length / 1MB, 1)) MB，版本 $($info.FileVersion)，來源 $source）"
