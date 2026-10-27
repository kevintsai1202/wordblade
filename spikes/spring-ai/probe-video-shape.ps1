# 直接用 REST 試 Meta 接受哪種「影片內容片段」格式（Spring AI 2.0.2 把影片當文字送，見 RESULT.md）
# 金鑰只從環境變數 META_API_KEY 讀，輸出不含金鑰。
# 用法：pwsh -File spikes/spring-ai/probe-video-shape.ps1 [-Clip clip30.mp4]
param([string]$Clip = 'clip30.mp4')
$ErrorActionPreference = 'Stop'
$key = $env:META_API_KEY
$model = $env:WORDBLADE_MODEL_SPARK
if (-not $key -or -not $model) { throw '需要環境變數 META_API_KEY 與 WORDBLADE_MODEL_SPARK' }
$b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot "media\$Clip")))
$uri = "data:video/mp4;base64,$b64"
$q = @{ type = 'text'; text = 'Describe what is on screen in two sentences. If you cannot see a video, say so.' }

# 候選格式：名稱 → 內容片段
$shapes = [ordered]@{
    'video_url'   = @{ type = 'video_url'; video_url = @{ url = $uri } }
    'input_video' = @{ type = 'input_video'; input_video = @{ data = $b64; format = 'mp4' } }
    'file'        = @{ type = 'file'; file = @{ filename = 'clip.mp4'; file_data = $uri } }
    'image_url'   = @{ type = 'image_url'; image_url = @{ url = $uri } }
}
foreach ($name in $shapes.Keys) {
    $body = @{ model = $model; reasoning_effort = 'low'
        messages = @(@{ role = 'user'; content = @($q, $shapes[$name]) }) } | ConvertTo-Json -Depth 10 -Compress
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $r = Invoke-RestMethod -Method Post -Uri 'https://api.meta.ai/v1/chat/completions' `
            -Headers @{ Authorization = "Bearer $key" } -ContentType 'application/json' -Body $body -TimeoutSec 300
        $t = [string]$r.choices[0].message.content
        "{0}: 200 {1}ms prompt_tokens={2} text={3}" -f $name, $sw.ElapsedMilliseconds, $r.usage.prompt_tokens, $t.Substring(0, [Math]::Min(160, $t.Length))
    } catch {
        $msg = "$($_.ErrorDetails.Message)"
        "{0}: FAIL {1}ms {2} {3}" -f $name, $sw.ElapsedMilliseconds, $_.Exception.Response.StatusCode.value__, $msg.Substring(0, [Math]::Min(300, $msg.Length))
    }
}
