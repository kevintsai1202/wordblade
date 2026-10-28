# SAM 3.1 實測（spec §5.3，docs/plan-10-28-sam.md）：起臨時 PostgreSQL（Docker，55432）與本機閘道（18080）→ 建一次性邀請權杖（只存雜湊）→
# 預設跑 scripts/sam/gateway-check.mjs（100 格計費、取消要多久、目標翻譯）；-E2E 時改跑 e2e/sam-live.spec.ts（網頁版完整流程）→ 收掉閘道與資料庫。
# 金鑰從 repo 的 .env 讀進這個行程的環境變數，不印出、不寫檔；權杖明文也只放環境變數。會實際呼叫 SAM（約 US$0.1 以內）。
# 用法（repo 根目錄，PowerShell 7）：pwsh scripts/sam/live-local.ps1 [-E2E] [-WebPort 4173]
# 紀錄：logs/sam-live.log（閘道的輸出另存 logs/sam-live-gateway.log）；結果：output/sam-gateway-check.json
param([switch]$E2E, [int]$WebPort = 4173)
$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$Log = Join-Path $Root 'logs/sam-live.log'
$GatewayLog = Join-Path $Root 'logs/sam-live-gateway.log'
New-Item -ItemType Directory -Force (Join-Path $Root 'logs') | Out-Null
$Db = 'wordblade-sam-live-db'
$Port = 18080

<# 寫一行紀錄（時間＋訊息），同時印出 #>
function Write-Log([string]$Message) {
  $line = '[{0}] {1}' -f (Get-Date -Format 'HH:mm:ss'), $Message
  Add-Content -Path $Log -Value $line
  Write-Host $line
}

# .env 的金鑰與模型 ID 放進環境變數（只放有值的）
foreach ($line in Get-Content (Join-Path $Root '.env')) {
  if ($line -match '^\s*(META_API_KEY|WORDBLADE_MODEL_[A-Z]+)\s*=\s*(.+?)\s*$') { Set-Item "Env:$($Matches[1])" $Matches[2] }
}
if (-not $env:META_API_KEY) { throw '.env 沒有 META_API_KEY' }

$gateway = $null
try {
  Write-Log '起臨時資料庫'
  docker run -d --rm --name $Db -p 55432:5432 -e POSTGRES_USER=wordblade -e POSTGRES_PASSWORD=wordblade -e POSTGRES_DB=wordblade postgres:17 | Out-Null
  for ($i = 0; $i -lt 30; $i++) {
    docker exec $Db pg_isready -U wordblade *> $null
    if ($LASTEXITCODE -eq 0) { break }
    Start-Sleep -Seconds 1
  }

  Write-Log '建置並啟動閘道'
  Push-Location (Join-Path $Root 'gateway')
  mvn -q package -DskipTests *>> $GatewayLog
  $jar = Get-ChildItem target -Filter 'gateway-*.jar' | Where-Object { $_.Name -notmatch 'plain' } | Select-Object -First 1
  Pop-Location
  $env:PORT = "$Port"
  $env:DB_URL = 'jdbc:postgresql://localhost:55432/wordblade'
  $env:WORDBLADE_CORS_ALLOWED_ORIGINS = "http://localhost:$WebPort"
  $env:WORDBLADE_E2E_PORT = "$WebPort"
  $gateway = Start-Process java -ArgumentList '-jar', $jar.FullName -PassThru -RedirectStandardOutput $GatewayLog -RedirectStandardError "$GatewayLog.err" -WindowStyle Hidden
  $ready = $false
  for ($i = 0; $i -lt 90 -and -not $ready; $i++) {
    Start-Sleep -Seconds 1
    try { Invoke-WebRequest "http://localhost:$Port/v1/me" -SkipHttpErrorCheck | Out-Null; $ready = $true } catch { }
  }
  if (-not $ready) { throw "閘道 90 秒內沒有起來，看 $GatewayLog" }

  $bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
  $token = 'wb-' + [Convert]::ToHexString($bytes).ToLower()
  $hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($token))).ToLower()
  docker exec $Db psql -U wordblade -d wordblade -c "INSERT INTO invite_token(name, token_sha256) VALUES ('sam-live', '$hash')" | Out-Null
  Write-Log '建立一次性權杖（只存雜湊），開始實測'

  $env:WORDBLADE_LIVE_GATEWAY = "http://localhost:$Port"
  $env:WORDBLADE_LIVE_TOKEN = $token
  Push-Location $Root
  if ($E2E) { pnpm playwright test e2e/sam-live.spec.ts 2>&1 | ForEach-Object { Write-Log $_ } }
  else { node scripts/sam/gateway-check.mjs 2>&1 | ForEach-Object { Write-Log $_ } }
  Pop-Location
  $usage = docker exec $Db psql -U wordblade -d wordblade -t -c "SELECT route, COUNT(*), SUM(units) FROM usage_log GROUP BY route" | Out-String
  Write-Log "用量：$($usage.Trim())"
} finally {
  Remove-Item Env:WORDBLADE_LIVE_TOKEN, Env:WORDBLADE_LIVE_GATEWAY, Env:WORDBLADE_E2E_PORT, Env:META_API_KEY -ErrorAction SilentlyContinue
  if ($gateway) { Stop-Process -Id $gateway.Id -ErrorAction SilentlyContinue }
  docker stop $Db *> $null
  Write-Log '已收掉閘道與臨時資料庫'
}
