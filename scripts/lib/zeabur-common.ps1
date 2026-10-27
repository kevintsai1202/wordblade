# Zeabur 部署腳本共用的函式（gateway-zeabur.ps1、web-zeabur.ps1 用 . 載入）。
# 呼叫端要先設好 $Log（紀錄檔路徑）。祕密值（金鑰、權杖）一律不輸出、不寫進紀錄。

$ZeaburEndStates = @('RUNNING', 'FAILED', 'CANCELED', 'CRASHED', 'REMOVED')  # 部署的終態

<# 寫一行帶時間的紀錄：同時輸出到主控台與紀錄檔。 #>
function Write-Log([string]$Message) {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $Message"
  [Console]::Out.WriteLine($line)
  Add-Content -Path $Log -Value $line -Encoding utf8
}

<# 呼叫 zeabur CLI（非互動、JSON 輸出）；結束碼非 0 或上傳準備逾時（CLI 此時仍回 0）直接丟錯。 #>
function Invoke-Zeabur([string[]]$CliArgs) {
  $text = & npx --yes zeabur@latest @CliArgs -i=false --json 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0 -or $text -match 'failed to prepare upload') { throw "zeabur $($CliArgs[0]) 失敗（exit ${LASTEXITCODE}）：$text" }
  return $text
}

<# 取出 CLI 輸出中的 JSON（前面可能有 INFO 行）。 #>
function ConvertFrom-ZeaburJson([string]$Text) {
  $start = $Text.IndexOfAny([char[]]'[{')
  if ($start -lt 0) { throw "CLI 輸出沒有 JSON：$Text" }
  return $Text.Substring($start) | ConvertFrom-Json
}

<# 呼叫 Zeabur GraphQL（權杖讀 CLI 設定檔，不輸出）；有 errors 就丟錯。 #>
function Invoke-Gql([string]$Query, [hashtable]$Variables = @{}) {
  $config = Get-Content (Join-Path $HOME '.config/zeabur/cli.yaml') -Raw
  $token = ([regex]::Match($config, '(?m)^token:\s*(.+)$').Groups[1].Value).Trim().Trim('"', "'")
  $body = @{ query = $Query; variables = $Variables } | ConvertTo-Json -Depth 10 -Compress
  $res = Invoke-RestMethod 'https://api.zeabur.com/graphql' -Method Post -ContentType 'application/json' -Headers @{ Authorization = "Bearer $token" } -Body $body
  if ($res.errors) { throw "GraphQL 錯誤：$(($res.errors | ForEach-Object { $_.message }) -join '; ')" }
  return $res.data
}

<# 把 CLI 的 context 切到這個專案（variable 指令在 context 不符時會靜默忽略 --id）。 #>
function Set-ZeaburProject([string]$ProjectId) {
  & npx --yes zeabur@latest context set project --id $ProjectId -i=false 2>&1 | Out-Null
}

<# 依名稱找專案內的服務 ID；找不到回空字串。 #>
function Find-Service([string]$ProjectId, [string]$Name) {
  $list = ConvertFrom-ZeaburJson (Invoke-Zeabur @('service', 'list', '--project-id', $ProjectId))
  $hit = @($list | Where-Object { $_.Name -eq $Name })
  if ($hit.Count -gt 1) { throw "專案內有 $($hit.Count) 個名為 $Name 的服務，請先到 Dashboard 清掉多餘的" }
  return $(if ($hit.Count) { $hit[0].ID } else { '' })
}

<# 讀服務的環境變數（原始值），回傳 key → value。 #>
function Get-Variables([string]$Sid) {
  $data = ConvertFrom-ZeaburJson (Invoke-Zeabur @('variable', 'list', '--id', $Sid))
  $map = @{}
  foreach ($v in @($data.variables)) { if ($v.key) { $map[$v.key] = [string]$v.value } }
  return $map
}

<# 整批寫入環境變數（variable env 是整份取代）：值一律單引號、保留 ${...} 給 Zeabur 代換；寫完讀回比對（不輸出值）。 #>
function Set-Variables([string]$Sid, [System.Collections.Specialized.OrderedDictionary]$Vars) {
  foreach ($k in @($Vars.Keys)) { if ([string]$Vars[$k] -match "['`r`n]") { throw "環境變數 $k 含單引號或換行，無法寫進 .env" } }
  $file = Join-Path ([IO.Path]::GetTempPath()) "wordblade-zb-$([guid]::NewGuid().ToString('N')).env"
  try {
    [IO.File]::WriteAllText($file, (($Vars.Keys | ForEach-Object { "$_='$($Vars[$_])'" }) -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
    Invoke-Zeabur @('variable', 'env', '--id', $Sid, '-f', $file) | Out-Null
  } finally { Remove-Item $file -Force -ErrorAction SilentlyContinue }
  $after = Get-Variables $Sid
  foreach ($k in $Vars.Keys) { if ($after[$k] -ne $Vars[$k]) { throw "環境變數 $k 寫入後與預期不同" } }
}

<# 取服務目前所有部署的 ID（用來鎖定這次新產生的部署）。 #>
function Get-DeploymentIds([string]$Sid) {
  $text = Invoke-Zeabur @('deployment', 'list', '--service-id', $Sid)
  if ($text.IndexOf('[') -lt 0) { return @() }
  return @((ConvertFrom-ZeaburJson $text) | ForEach-Object { $_.ID })
}

<# 等這次的部署到終態：每 30 秒查一次，最多 $Minutes 分鐘；回傳終態字串。 #>
function Wait-Deployment([string]$Sid, [string[]]$Before, [int]$Minutes = 40) {
  $deadline = (Get-Date).AddMinutes($Minutes)
  $target = $null
  while ((Get-Date) -lt $deadline) {
    $text = Invoke-Zeabur @('deployment', 'list', '--service-id', $Sid)
    $list = if ($text.IndexOf('[') -ge 0) { ConvertFrom-ZeaburJson $text } else { @() }
    if (-not $target) { $target = $list | Where-Object { $Before -notcontains $_.ID } | Select-Object -First 1 }
    if ($target) {
      $now = $list | Where-Object { $_.ID -eq $target.ID } | Select-Object -First 1
      Write-Log "部署 $($now.ID)：$($now.status)"
      if ($ZeaburEndStates -contains $now.status) { return $now.status }
    } else { Write-Log '尚未看到這次的部署紀錄' }
    Start-Sleep -Seconds 30
  }
  throw "等待部署逾時（$Minutes 分鐘）"
}

<#
 部署部署目錄 $Stage 並等到終態。第一次（沒有 $ServiceId）會建新服務，呼叫 $OnCreated 寫變數後帶 --service-id 再部署一次
 （新服務第一次建置時還沒有變數；不帶 --service-id 會多一個重複服務）。回傳 @{ serviceId; status }。
#>
function Publish-Stage([string]$ProjectId, [string]$ServiceId, [string]$Name, [string]$Stage, [scriptblock]$OnCreated) {
  $before = if ($ServiceId) { Get-DeploymentIds $ServiceId } else { @() }
  $cli = @('deploy', '--project-id', $ProjectId) + $(if ($ServiceId) { @('--service-id', $ServiceId) } else { @('--name', $Name) })
  Push-Location $Stage
  try { Write-Log ((Invoke-Zeabur $cli).Trim()) } finally { Pop-Location }
  if (-not $ServiceId) {
    $ServiceId = Find-Service $ProjectId $Name
    if (-not $ServiceId) { throw '部署後找不到新服務，請到 Dashboard 查' }
    Write-Log "新服務 ID：$ServiceId；寫好變數後再部署一次"
    & $OnCreated $ServiceId
    return Publish-Stage $ProjectId $ServiceId $Name $Stage $OnCreated
  }
  return @{ serviceId = $ServiceId; status = (Wait-Deployment $ServiceId $before) }
}

<#
 幫 Wonder Mesh 自架主機上的服務綁 <前綴>.zeabur.app：CLI 建不了網域（WONDER_MESH_SERVER_REQUIRES_GATEWAY），
 改用 GraphQL attachWonderMeshUpstream 綁到東京閘道。已綁過（同 meshPort）就略過；回傳完整網域。
#>
function Connect-WonderMeshDomain([string]$ServiceId, [string]$EnvironmentId, [string]$Prefix, [int]$Port, [string]$ServerId, [string]$NodeId = '292') {
  $domainHost = "$Prefix.zeabur.app"
  $me = (Invoke-Gql '{ me { _id } }').me._id
  $gw = (Invoke-Gql 'query($o: ObjectID){ wonderMeshGateway(ownerID: $o){ routes { host meshPort } } }' @{ o = $me }).wonderMeshGateway
  $ports = (Invoke-Gql 'query($id: ObjectID, $env: ObjectID!){ service(_id: $id){ ports(environmentID: $env){ port type forwardedPort } } }' @{ id = $ServiceId; env = $EnvironmentId }).service.ports
  $meshPort = (@($ports) | Where-Object { $_.port -eq $Port } | Select-Object -First 1).forwardedPort
  if (-not $meshPort) { throw "服務 $Port 埠沒有 forwardedPort：$($ports | ConvertTo-Json -Compress)" }
  $existing = @($gw.routes) | Where-Object { $_.host -eq $domainHost }
  if ($existing) {
    if ($existing.meshPort -ne $meshPort) { throw "$domainHost 已綁到 meshPort $($existing.meshPort)，和服務目前的 $meshPort 不同，請到 Dashboard 檢查" }
    Write-Log "網域 $domainHost 已綁定（meshPort $meshPort）"
  } else {
    $check = (Invoke-Gql 'mutation($d: String!, $r: String!){ checkDomainAvailable(domain: $d, isGenerated: true, region: $r){ isAvailable reason } }' @{ d = $Prefix; r = "server-$ServerId" }).checkDomainAvailable
    if (-not $check.isAvailable) { throw "網域 $domainHost 不能用：$($check.reason)（換一個前綴）" }
    Invoke-Gql 'mutation($in: AttachWonderMeshUpstreamInput!){ attachWonderMeshUpstream(input: $in){ routes { host } } }' @{ in = @{ nodeID = $NodeId; meshPort = $meshPort; domainName = $Prefix; isGenerated = $true; ownerID = $me } } | Out-Null
    Write-Log "網域 $domainHost 綁到 meshPort $meshPort（東京閘道）"
  }
  return $domainHost
}

<# 讀網域憑證的簽發者（剛綁好時常是 Zeabur 自簽的佔位憑證）；讀不到回說明文字。 #>
function Get-CertIssuer([string]$DomainHost) {
  $tcp = $null
  try {
    $tcp = [Net.Sockets.TcpClient]::new($DomainHost, 443)
    $ssl = [Net.Security.SslStream]::new($tcp.GetStream(), $false, { $true })
    $ssl.AuthenticateAsClient($DomainHost)
    return $ssl.RemoteCertificate.Issuer
  } catch { return "（讀不到：$($_.Exception.Message)）" } finally { if ($tcp) { $tcp.Dispose() } }
}
