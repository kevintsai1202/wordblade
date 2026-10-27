# 以 video_url 格式量每格 token，並測「影片＋json_schema 結構化輸出」組合（AI 導演逐段分析的實際形態）
# 金鑰只從環境變數 META_API_KEY 讀。用法：pwsh -File spikes/spring-ai/probe-video-director.ps1
$ErrorActionPreference = 'Stop'
$key = $env:META_API_KEY; $model = $env:WORDBLADE_MODEL_SPARK
if (-not $key -or -not $model) { throw '需要環境變數 META_API_KEY 與 WORDBLADE_MODEL_SPARK' }

# 呼叫並回報耗時、usage 與回覆前 200 字
function Invoke-Chat($label, $content, $extra) {
    $body = @{ model = $model; reasoning_effort = 'low'; messages = @(@{ role = 'user'; content = $content }) }
    foreach ($k in $extra.Keys) { $body[$k] = $extra[$k] }
    $json = $body | ConvertTo-Json -Depth 12 -Compress
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $r = Invoke-RestMethod -Method Post -Uri 'https://api.meta.ai/v1/chat/completions' `
            -Headers @{ Authorization = "Bearer $key" } -ContentType 'application/json' -Body $json -TimeoutSec 300
        $t = [string]$r.choices[0].message.content
        "{0}: 200 {1}ms request_kb={2} prompt={3} completion={4} text={5}" -f $label, $sw.ElapsedMilliseconds, [int]($json.Length / 1024), $r.usage.prompt_tokens, $r.usage.completion_tokens, $t.Substring(0, [Math]::Min(200, $t.Length))
    } catch {
        $m = "$($_.ErrorDetails.Message)"
        "{0}: FAIL {1}ms {2}" -f $label, $sw.ElapsedMilliseconds, $m.Substring(0, [Math]::Min(300, $m.Length))
    }
}

function Video($clip) {
    $b64 = [Convert]::ToBase64String([IO.File]::ReadAllBytes((Join-Path $PSScriptRoot "media\$clip")))
    @{ type = 'video_url'; video_url = @{ url = "data:video/mp4;base64,$b64" } }
}
$ask = @{ type = 'text'; text = 'Describe what is on screen in two sentences.' }

# 每格 token：10 秒（約 22 格）與 30 秒（62 格）兩點，prompt_tokens 相減再除以格數差
Invoke-Chat 'video10-plain' @($ask, (Video 'clip10.mp4')) @{}
Invoke-Chat 'video30-plain' @($ask, (Video 'clip30.mp4')) @{}

# 影片＋json_schema（strict）
$schema = @{ type = 'object'; additionalProperties = $false
    required = @('topic', 'issues')
    properties = @{ topic = @{ type = 'string' }
        issues = @{ type = 'array'; items = @{ type = 'object'; additionalProperties = $false
            required = @('startSec', 'endSec', 'kind')
            properties = @{ startSec = @{ type = 'number' }; endSec = @{ type = 'number' }
                kind = @{ type = 'string'; enum = @('stumble', 'privacy', 'highlight') } } } } } }
$rf = @{ response_format = @{ type = 'json_schema'; json_schema = @{ name = 'segment_report'; strict = $true; schema = $schema } } }
$ask2 = @{ type = 'text'; text = 'Silent lecture clip. Give the topic and any highlight moments (seconds from clip start).' }
Invoke-Chat 'video30-json_schema' @($ask2, (Video 'clip30.mp4')) $rf
