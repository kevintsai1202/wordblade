# 把網頁版（vite build 的 dist/）部署到 Zeabur 專案 wordblade 的服務 wordblade-web（神奇網路主機），網域 wordblade.zeabur.app。
# 專案與環境沿用閘道的 gateway/zeabur.json（先跑過 scripts/gateway-zeabur.ps1）；這個服務的 ID 記在 deploy/web/zeabur.json。
#
# 用法（repo 根目錄，PowerShell 7）：
#   pwsh scripts/web-zeabur.ps1               建置 → 組部署目錄 → 部署 → 等部署結束 → 綁網域 → 驗證
#   pwsh scripts/web-zeabur.ps1 -StageOnly    只建置並組部署目錄
#   pwsh scripts/web-zeabur.ps1 -VerifyOnly   只驗證線上版
# 注意：samples/ 的示範影片不會部署（太大、家用節點傳影片慢）；範例專案的素材之後另外處理（spec §5.22）。
# 紀錄：logs/web-zeabur.log
param(
  [string]$ServerId = '69eeeb93f5343e60f36375c2',   # 神奇網路主機（Wonder Mesh）
  [string]$ServiceName = 'wordblade-web',
  [string]$DomainPrefix = 'wordblade',               # 公開網域 <前綴>.zeabur.app（閘道的 CORS 清單要有它）
  [switch]$StageOnly,
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'

$Root = Split-Path $PSScriptRoot -Parent
$ProjectFile = Join-Path $Root 'gateway/zeabur.json'                    # 專案與環境 ID（閘道部署時建立）
$StateFile = Join-Path $Root 'deploy/web/zeabur.json'                   # 這個服務的 ID 與網域
$Stage = Join-Path ([IO.Path]::GetTempPath()) 'wordblade-web-zeabur'   # 部署目錄（repo 之外）
$Log = Join-Path $Root 'logs/web-zeabur.log'
New-Item -ItemType Directory -Force (Split-Path $Log) | Out-Null
. (Join-Path $PSScriptRoot 'lib/zeabur-common.ps1')

<# 讀寫這個服務的狀態檔。 #>
function Get-State { if (Test-Path $StateFile) { Get-Content $StateFile -Raw | ConvertFrom-Json -AsHashtable } else { @{} } }
function Save-State([hashtable]$State) { $State | ConvertTo-Json | Set-Content -Encoding utf8NoBOM $StateFile }

<# 建置網頁版並組部署目錄：Dockerfile、nginx.conf、dist/。 #>
function New-Stage {
  Push-Location $Root
  try {
    pnpm build 2>&1 | Tee-Object -FilePath (Join-Path $Root 'logs/web-build.log') | Select-Object -Last 3 | ForEach-Object { Write-Log $_ }
    if ($LASTEXITCODE -ne 0) { throw '網頁版建置失敗，見 logs/web-build.log' }
  } finally { Pop-Location }
  if ((Split-Path $Stage -Leaf) -ne 'wordblade-web-zeabur') { throw "部署目錄路徑異常：$Stage" }
  if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
  New-Item -ItemType Directory -Force $Stage | Out-Null
  Copy-Item (Join-Path $Root 'deploy/web/Dockerfile'), (Join-Path $Root 'deploy/web/nginx.conf') $Stage
  Copy-Item (Join-Path $Root 'dist') (Join-Path $Stage 'dist') -Recurse
  $mb = [math]::Round(((Get-ChildItem $Stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 2)
  Write-Log "部署目錄：$Stage（${mb} MB）"
}

<# 網頁服務的環境變數：指定用 Dockerfile 建置、nginx 聽 8080。 #>
function Set-WebVariables([string]$Sid) {
  Set-Variables $Sid ([ordered]@{ ZBPACK_DOCKERFILE_PATH = 'Dockerfile'; PORT = '8080' })
  Write-Log '環境變數已同步：ZBPACK_DOCKERFILE_PATH、PORT'
}

<# 線上驗證：首頁 200、有 COOP／COEP 標頭、內容是 WordBlade 的 index.html，且引用的 JS 拿得到。 #>
function Test-Live([string]$DomainHost) {
  $url = "https://$DomainHost"
  Write-Log "憑證簽發者：$(Get-CertIssuer $DomainHost)"
  $page = Invoke-WebRequest "$url/" -SkipHttpErrorCheck -SkipCertificateCheck -UseBasicParsing
  $coop = "$($page.Headers['Cross-Origin-Opener-Policy'])"
  $coep = "$($page.Headers['Cross-Origin-Embedder-Policy'])"
  Write-Log "GET /：$($page.StatusCode)；COOP=$coop；COEP=$coep"
  if ($page.StatusCode -ne 200 -or $page.Content -notmatch '<title>WordBlade</title>' -or $coop -ne 'same-origin' -or $coep -ne 'require-corp') { throw '線上驗證未通過：首頁或標頭不對' }
  $js = [regex]::Match($page.Content, 'src="(/assets/[^"]+\.js)"').Groups[1].Value
  $asset = Invoke-WebRequest "$url$js" -SkipHttpErrorCheck -SkipCertificateCheck -UseBasicParsing
  Write-Log "GET $js：$($asset.StatusCode)"
  if ($asset.StatusCode -ne 200) { throw '線上驗證未通過：JS 拿不到' }
  Write-Log '線上驗證通過'
}

Write-Log "== web-zeabur 開始（$ServiceName）"
if (-not (Test-Path $ProjectFile)) { throw '找不到 gateway/zeabur.json：先跑 scripts/gateway-zeabur.ps1 建專案' }
$project = Get-Content $ProjectFile -Raw | ConvertFrom-Json
$state = Get-State
if ($VerifyOnly) { Test-Live $state.domain; return }
New-Stage
if ($StageOnly) { Write-Log '只組部署目錄，結束'; return }

Set-ZeaburProject $project.projectId
if (-not $state.serviceId) { $state.serviceId = Find-Service $project.projectId $ServiceName }
if ($state.serviceId) { Set-WebVariables $state.serviceId }
$result = Publish-Stage $project.projectId $state.serviceId $ServiceName $Stage { param($sid) Set-WebVariables $sid }
$state.serviceId = $result.serviceId
Save-State $state
if ($result.status -ne 'RUNNING') { throw "部署結束狀態為 $($result.status)：npx zeabur@latest deployment log --service-id $($state.serviceId) -t build -i=false 查原因" }
$state.domain = Connect-WonderMeshDomain $state.serviceId $project.environmentId $DomainPrefix 8080 $ServerId
Save-State $state
Start-Sleep -Seconds 10
Test-Live $state.domain
Write-Log "== 完成：https://$($state.domain)"
