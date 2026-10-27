# 線上閘道的 Vibe特效實測：在本機產生一次性的邀請權杖（資料庫只存雜湊）→ 用它跑 scripts/vibe/gateway-check.mjs → 跑完停用這個權杖。
# 權杖明文只放在這個行程的環境變數，不印出、不寫檔。
# 用法（repo 根目錄，PowerShell 7）：pwsh scripts/vibe/prod-check.ps1 [-Description '<描述>']
# 紀錄：logs/vibe-prod-check.log
param(
  [string]$Description = 'A burst of colorful confetti shooting up from the bottom of the box',
  [string]$DbServiceName = 'postgresql'
)
$ErrorActionPreference = 'Stop'

$Root = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$Log = Join-Path $Root 'logs/vibe-prod-check.log'
. (Join-Path $Root 'scripts/lib/zeabur-common.ps1')
$state = Get-Content (Join-Path $Root 'gateway/zeabur.json') -Raw | ConvertFrom-Json
Set-ZeaburProject $state.projectId
$dbSid = Find-Service $state.projectId $DbServiceName
$name = 'vibe-prod-check-' + (Get-Date -Format 'MMddHHmm')

<# 在線上資料庫執行一句 SQL（psql 在資料庫服務裡跑） #>
function Invoke-Sql([string]$Sql) {
  & npx --yes zeabur@latest service exec --id $dbSid -i=false '--' sh -c "psql -U `"`$POSTGRES_USERNAME`" -d zeabur -c `"$Sql`"" 2>&1 | Out-String
}

$bytes = [Security.Cryptography.RandomNumberGenerator]::GetBytes(16)
$token = 'wb-' + [Convert]::ToHexString($bytes).ToLower()
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($token))).ToLower()
Invoke-Sql "INSERT INTO invite_token(name, token_sha256) VALUES ('$name', '$hash')" | Out-Null
Write-Log "建立一次性權杖「$name」（只存雜湊）"
try {
  $env:WORDBLADE_TOKEN = $token
  node (Join-Path $Root 'scripts/vibe/gateway-check.mjs') "https://$($state.domain)" $Description 2>&1 | ForEach-Object { Write-Log $_ }
} finally {
  Remove-Item Env:WORDBLADE_TOKEN -ErrorAction SilentlyContinue
  Invoke-Sql "UPDATE invite_token SET disabled = true WHERE name = '$name'" | Out-Null
  Write-Log "已停用權杖「$name」"
}
