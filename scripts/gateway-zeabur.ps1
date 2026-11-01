# 把 AI 閘道（gateway/）部署到 Zeabur 的「神奇網路主機」（Wonder Mesh 自架節點，server-69eeeb93f5343e60f36375c2），
# 專案 wordblade 放閘道＋PostgreSQL（spec Q2、§6）。可重跑；建立過的專案／服務 ID 記在 gateway/zeabur.json（不含祕密）。
#
# 用法（repo 根目錄，PowerShell 7）：
#   pwsh scripts/gateway-zeabur.ps1                       建專案（第一次）→ PostgreSQL → 同步變數 → 部署 → 等部署結束 → 綁網域 → 驗證
#   pwsh scripts/gateway-zeabur.ps1 -StageOnly            只組部署目錄
#   pwsh scripts/gateway-zeabur.ps1 -VerifyOnly           只驗證線上版
#   pwsh scripts/gateway-zeabur.ps1 -NewToken '評審A'      新增一把邀請權杖（原文只顯示一次，資料庫只存 SHA-256），不重新部署
#
# 注意（作者先前在同一個節點踩過的坑）：
#   - 直傳目錄要設 ZBPACK_DOCKERFILE_PATH=Dockerfile，否則可能被當成別種專案建置。
#   - 網域 502 但服務 RUNNING 時，先查 wonder-mesh-gateway 專案的 tailscale-sidecar 是不是 SUSPENDED。
#   - 其餘（context、整份取代變數、新服務要部署兩次、網域走閘道）見 scripts/lib/zeabur-common.ps1。
# 紀錄：logs/gateway-zeabur.log（不含祕密）
param(
  [string]$ServerId = '69eeeb93f5343e60f36375c2',   # 神奇網路主機（Wonder Mesh）
  [string]$ProjectName = 'wordblade',
  [string]$ServiceName = 'wordblade-gateway',        # 內網主機名 <名稱>.zeabur.internal
  [string]$DbServiceName = 'postgresql',
  [string]$DomainPrefix = 'wordblade-api',           # 公開網域 <前綴>.zeabur.app
  # 允許呼叫閘道的來源：開發伺服器、Windows 版 WebView2、網頁版正式網域
  [string]$CorsOrigins = 'http://localhost:1420,http://tauri.localhost,https://wordblade.zeabur.app',
  [string]$NewToken = '',
  [switch]$StageOnly,
  [switch]$VerifyOnly
)
$ErrorActionPreference = 'Stop'

$Root = Split-Path $PSScriptRoot -Parent
$StateFile = Join-Path $Root 'gateway/zeabur.json'                          # 專案／服務 ID 與網域（不含祕密）
$Stage = Join-Path ([IO.Path]::GetTempPath()) 'wordblade-gateway-zeabur'   # 部署目錄（repo 之外，不帶 target/）
$Log = Join-Path $Root 'logs/gateway-zeabur.log'
New-Item -ItemType Directory -Force (Split-Path $Log) | Out-Null
. (Join-Path $PSScriptRoot 'lib/zeabur-common.ps1')

<# 讀寫狀態檔（專案、環境、服務 ID、網域）。 #>
function Get-State { if (Test-Path $StateFile) { Get-Content $StateFile -Raw | ConvertFrom-Json -AsHashtable } else { @{} } }
function Save-State([hashtable]$State) { $State | ConvertTo-Json | Set-Content -Encoding utf8NoBOM $StateFile }

<# 讀專案 .env 裡指定的鍵（值不輸出）。 #>
function Read-DotEnv([string[]]$Keys) {
  $out = [ordered]@{}
  foreach ($line in Get-Content (Join-Path $Root '.env') -Encoding utf8) {
    if ($line -match '^([A-Z_][A-Z0-9_]*)=(.*)$' -and $Keys -contains $Matches[1] -and $Matches[2].Trim()) { $out[$Matches[1]] = $Matches[2].Trim().Trim('"', "'") }
  }
  return $out
}

<# 確保專案存在（第一次建在神奇網路主機上），並記下環境 ID。 #>
function Initialize-Project([hashtable]$State) {
  if (-not $State.projectId) {
    $created = ConvertFrom-ZeaburJson (Invoke-Zeabur @('project', 'create', '-n', $ProjectName, '-r', "server-$ServerId"))
    $State.projectId = @($created._id, $created.ID, $created.id) | Where-Object { $_ } | Select-Object -First 1
    if (-not $State.projectId) { throw "建立專案後讀不到 ID：$($created | ConvertTo-Json -Compress)" }
    Write-Log "建立專案 $ProjectName：$($State.projectId)（server-$ServerId）"
  }
  Set-ZeaburProject $State.projectId
  if (-not $State.environmentId) {
    $p = Invoke-Gql 'query($id: ObjectID){ project(_id: $id){ region { id } environments { _id } } }' @{ id = $State.projectId }
    if ($p.project.region.id -ne "server-$ServerId") { throw "專案不在神奇網路主機上（region=$($p.project.region.id)）" }
    $State.environmentId = @($p.project.environments)[0]._id
    Write-Log "環境：$($State.environmentId)"
  }
  Save-State $State
}

<# 組部署目錄：只放 Dockerfile、pom.xml、src/。 #>
function New-Stage {
  if ((Split-Path $Stage -Leaf) -ne 'wordblade-gateway-zeabur') { throw "部署目錄路徑異常：$Stage" }
  if (Test-Path $Stage) { Remove-Item $Stage -Recurse -Force }
  New-Item -ItemType Directory -Force $Stage | Out-Null
  foreach ($item in 'Dockerfile', 'pom.xml', 'src') { Copy-Item (Join-Path $Root "gateway/$item") $Stage -Recurse }
  $mb = [math]::Round(((Get-ChildItem $Stage -Recurse -File | Measure-Object Length -Sum).Sum / 1MB), 2)
  Write-Log "部署目錄：$Stage（${mb} MB）"
}

<# 閘道的環境變數：資料庫走內網、帳密引用 PostgreSQL 服務的變數；金鑰與模型 ID 從 .env 帶入（只記名稱）。 #>
function Set-GatewayVariables([string]$Sid) {
  $vars = [ordered]@{
    ZBPACK_DOCKERFILE_PATH         = 'Dockerfile'
    PORT                           = '8080'
    DB_URL                         = "jdbc:postgresql://$DbServiceName.zeabur.internal:5432/zeabur"
    DB_USER                        = '${POSTGRES_USERNAME}'
    DB_PASSWORD                    = '${POSTGRES_PASSWORD}'
    WORDBLADE_CORS_ALLOWED_ORIGINS = $CorsOrigins
    WORDBLADE_TIMEZONE             = 'Asia/Taipei'
  }
  $fromEnv = Read-DotEnv @('META_API_KEY', 'WORDBLADE_MODEL_SPARK', 'WORDBLADE_MODEL_WONDER', 'WORDBLADE_MODEL_IMAGE', 'WORDBLADE_MODEL_SAM', 'WORDBLADE_MODEL_ASR', 'FISH_API_KEY', 'TYPESAFE_API_KEY', 'WORDBLADE_MODEL_JEV')
  if (-not $fromEnv.Contains('META_API_KEY')) { throw '.env 缺少 META_API_KEY' }
  foreach ($k in $fromEnv.Keys) { $vars[$k] = $fromEnv[$k] }
  Set-Variables $Sid $vars
  Write-Log "環境變數已同步：$($vars.Count) 個（從 .env 帶入：$($fromEnv.Keys -join '、')）；CORS：$CorsOrigins"
}

<# 新增一把邀請權杖：原文只顯示一次，資料庫只存 SHA-256（在 PostgreSQL 容器裡執行 psql）。 #>
function New-InviteToken([hashtable]$State, [string]$Name) {
  if ($Name -match "'") { throw '權杖名稱不能含單引號' }
  $dbSid = Find-Service $State.projectId $DbServiceName
  $bytes = [byte[]]::new(24); [Security.Cryptography.RandomNumberGenerator]::Fill($bytes)
  $token = 'wb-' + [Convert]::ToHexString($bytes).ToLower()
  $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($token))).ToLower()
  $sql = "INSERT INTO invite_token(name, token_sha256) VALUES ('$Name', '$hash')"
  # '--' 要加引號：PowerShell 會吃掉原生指令參數裡第一個沒加引號的 --，後面的 -c 就被當成 zeabur 自己的參數
  $out = & npx --yes zeabur@latest service exec --id $dbSid -i=false '--' sh -c "psql -U `"`$POSTGRES_USERNAME`" -d zeabur -c `"$sql`"" 2>&1 | Out-String
  if ($out -notmatch 'INSERT 0 1') { throw "新增權杖失敗：$out" }
  Write-Log "新增邀請權杖「$Name」（只存雜湊）"
  return $token
}

<# 線上驗證：沒帶權杖回 401；帶權杖回 200；印出憑證簽發者。 #>
function Test-Live([hashtable]$State, [string]$Token) {
  $url = "https://$($State.domain)"
  Write-Log "憑證簽發者：$(Get-CertIssuer $State.domain)"
  $anon = Invoke-WebRequest "$url/v1/me" -SkipHttpErrorCheck -SkipCertificateCheck -UseBasicParsing
  Write-Log "GET /v1/me（無權杖）：$($anon.StatusCode)"
  if ($anon.StatusCode -ne 401) { throw '線上驗證未通過：無權杖應回 401' }
  if ($Token) {
    $auth = Invoke-WebRequest "$url/v1/me" -Headers @{ Authorization = "Bearer $Token" } -SkipHttpErrorCheck -SkipCertificateCheck -UseBasicParsing
    Write-Log "GET /v1/me（新權杖）：$($auth.StatusCode)"
    if ($auth.StatusCode -ne 200) { throw '線上驗證未通過：帶權杖應回 200' }
  }
  Write-Log '線上驗證通過'
}

Write-Log "== gateway-zeabur 開始（$ProjectName／$ServiceName）"
$state = Get-State
if ($StageOnly) { New-Stage; Write-Log '只組部署目錄，結束'; return }
Initialize-Project $state

if ($VerifyOnly) { Test-Live $state ''; return }
if ($NewToken) {
  $token = New-InviteToken $state $NewToken
  Test-Live $state $token
  Write-Host "`n邀請權杖（只顯示這一次，請自己保存）：$token`n"
  return
}

if (-not (Find-Service $state.projectId $DbServiceName)) {
  Write-Log "專案內沒有 $DbServiceName，部署 PostgreSQL 範本（B20CX0）"
  & npx --yes zeabur@latest template deploy -c B20CX0 --project-id $state.projectId -i=false 2>&1 | Out-String | ForEach-Object { Write-Log $_.Trim() }
  if (-not (Find-Service $state.projectId $DbServiceName)) { throw "PostgreSQL 範本部署後仍找不到服務 $DbServiceName" }
}

New-Stage
if ($state.serviceId) { Set-GatewayVariables $state.serviceId }
$result = Publish-Stage $state.projectId $state.serviceId $ServiceName $Stage { param($sid) Set-GatewayVariables $sid }
$state.serviceId = $result.serviceId
Save-State $state
if ($result.status -ne 'RUNNING') { throw "部署結束狀態為 $($result.status)：npx zeabur@latest deployment log --service-id $($state.serviceId) -t build -i=false 查原因" }
$state.domain = Connect-WonderMeshDomain $state.serviceId $state.environmentId $DomainPrefix 8080 $ServerId
Save-State $state
Start-Sleep -Seconds 10
Test-Live $state ''
Write-Log "== 完成：https://$($state.domain)"
