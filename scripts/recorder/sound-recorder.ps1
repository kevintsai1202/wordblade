# WordBlade recording fallback (spec 5.18, developer decision 2026-10-27): when getUserMedia fails in the Windows app
# (NotReadableError / NotAllowedError / 8 s timeout, e.g. Kaspersky blocking the microphone for unsigned apps),
# drive the built-in Windows Sound Recorder (Microsoft-signed, launched by the shell, not our child process) with UI Automation.
# Ported from the original project (transcript-review backend/narration.py, tested 2026-10-19 on a Kaspersky machine).
# Usage (Windows PowerShell 5.1 or 7): powershell -NoProfile -ExecutionPolicy Bypass -File sound-recorder.ps1 start|stop
# Prints one JSON line: start -> {ok, startedAt (Unix ms)}; stop -> {ok, stoppedAt, path (.m4a)}; failure -> {ok:false, error}.
# ASCII only: Windows PowerShell 5.1 misreads non-ASCII in a BOM-less script. src-tauri embeds this file (include_str!).
param([string]$Action)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
$A = [System.Windows.Automation.AutomationElement]
$TS = [System.Windows.Automation.TreeScope]
$pfn = 'Microsoft.WindowsSoundRecorder_8wekyb3d8bbwe'
$regKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\microphone\$pfn"
function Out-Result($obj) { Write-Output ($obj | ConvertTo-Json -Compress); exit 0 }
function Fail($msg) { Out-Result @{ ok = $false; error = $msg } }
function Reg { Get-ItemProperty $regKey -ErrorAction SilentlyContinue }
function RegStart { $p = Reg; if ($p -and $p.LastUsedTimeStart) { [long]$p.LastUsedTimeStart } else { [long]0 } }
function RegStop { $p = Reg; if ($p -and $p.LastUsedTimeStop) { [long]$p.LastUsedTimeStop } else { [long]0 } }
function ToMs([long]$ft) { [long][math]::Floor(($ft - 116444736000000000) / 10000) }
function Find-Btn($win, $id) {
  $c = New-Object System.Windows.Automation.PropertyCondition($A::AutomationIdProperty, $id)
  $win.FindFirst($TS::Descendants, $c)
}
function Find-Win {
  $cond = New-Object System.Windows.Automation.PropertyCondition($A::ClassNameProperty, 'ApplicationFrameWindow')
  $frames = $A::RootElement.FindAll($TS::Children, $cond)
  foreach ($w in $frames) {
    foreach ($id in 'RecordButton', 'StopRecordingButton', 'ImportFileButton') { if (Find-Btn $w $id) { return $w } }
  }
  # Minimized: the UIA tree is gone, so fall back to the (localized) title; callers restore the window and look again.
  $zh = [string]::Concat([char]0x9304, [char]0x97F3, [char]0x6A5F)  # the localized title (zh-TW) without putting non-ASCII in this script
  foreach ($w in $frames) { if ($w.Current.Name -match ('Sound Recorder|Voice Recorder|' + $zh)) { return $w } }
  $null
}
function Wait-Win([int]$seconds) {
  for ($i = 0; $i -lt $seconds * 5; $i++) { $w = Find-Win; if ($w) { return $w }; Start-Sleep -Milliseconds 200 }
  $null
}
function Invoke-Btn($btn) { $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() }
Add-Type -Namespace Win32 -Name Fg -MemberDefinition '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);'

if ($Action -eq 'start') {
  $fg = [Win32.Fg]::GetForegroundWindow()  # the workbench; a cold-launched UWP app steals focus
  $win = Find-Win
  if ($win) { try { $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal); Start-Sleep -Milliseconds 300; $w2 = Find-Win; if ($w2) { $win = $w2 } } catch { } }  # left minimized by a previous take
  if (-not $win) {
    Start-Process "shell:AppsFolder\$pfn!App"
    $win = Wait-Win 15
    if (-not $win) { Fail 'recorder-window-not-found' }
  }
  # If a previous take is still running (Stop cleared to 0), stop it first.
  if ((RegStop) -eq 0 -and (RegStart) -gt 0) {
    $s = Find-Btn $win 'StopRecordingButton'
    if ($s) { Invoke-Btn $s; for ($i = 0; $i -lt 50 -and (RegStop) -eq 0; $i++) { Start-Sleep -Milliseconds 200 } }
  }
  # Shrink to the app's minimum size and park it at the bottom-right of the work area (minimizing kills the UIA tree).
  try {
    $tp = $win.GetCurrentPattern([System.Windows.Automation.TransformPattern]::Pattern)
    $tp.Resize(100, 100); Start-Sleep -Milliseconds 200
    $r = $win.Current.BoundingRectangle; $scr = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    $tp.Move($scr.Right - $r.Width, $scr.Bottom - $r.Height)
  } catch { }
  $rec = $null
  for ($i = 0; $i -lt 75 -and -not $rec; $i++) { $rec = Find-Btn $win 'RecordButton'; if (-not $rec) { Start-Sleep -Milliseconds 200 } }
  if (-not $rec) { Fail 'record-button-not-found' }
  $before = RegStart
  Invoke-Btn $rec
  $started = [long]0
  for ($i = 0; $i -lt 50; $i++) { $s = RegStart; if ($s -gt $before -and (RegStop) -eq 0) { $started = $s; break }; Start-Sleep -Milliseconds 100 }
  if ($started -eq 0) { Fail 'recording-did-not-start' }
  # Recording keeps running while minimized; the UIA tree only disappears, so 'stop' restores the window first.
  try { $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Minimized) } catch { }
  try { [void][Win32.Fg]::SetForegroundWindow($fg) } catch { }
  Out-Result @{ ok = $true; startedAt = (ToMs $started) }
}
elseif ($Action -eq 'stop') {
  $fg = [Win32.Fg]::GetForegroundWindow()
  $win = Find-Win
  $before = RegStop
  $s = $null
  if ($win) {
    $s = Find-Btn $win 'StopRecordingButton'
    if (-not $s) {
      # Minimized: restore, wait for the UIA tree to come back (about 300 ms), then look again.
      try { $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal) } catch { }
      for ($i = 0; $i -lt 25 -and -not $s; $i++) { Start-Sleep -Milliseconds 200; $w2 = Find-Win; if ($w2) { $win = $w2; $s = Find-Btn $win 'StopRecordingButton' } }
    }
    if ($s) { Invoke-Btn $s }
  }
  $stopped = [long]0
  for ($i = 0; $i -lt 100; $i++) { $v = RegStop; if ($v -gt 0 -and ($v -ge $before)) { $stopped = $v; break }; Start-Sleep -Milliseconds 100 }
  if ($stopped -eq 0) { Fail 'recording-did-not-stop' }
  $stopTime = [DateTime]::FromFileTime($stopped)
  # The file is finalized a few hundred ms after Stop; look for the .m4a whose mtime is closest to Stop (folder name is localized).
  $docs = [Environment]::GetFolderPath('MyDocuments'); $best = $null; $bestDiff = 5.0
  for ($i = 0; $i -lt 20 -and -not $best; $i++) {
    Start-Sleep -Milliseconds 250
    foreach ($d in (Get-ChildItem $docs -Directory -ErrorAction SilentlyContinue)) {
      foreach ($f in (Get-ChildItem $d.FullName -File -Filter *.m4a -ErrorAction SilentlyContinue)) {
        $diff = [math]::Abs(($f.LastWriteTime - $stopTime).TotalSeconds)
        if ($diff -lt $bestDiff) { $bestDiff = $diff; $best = $f }
      }
    }
  }
  if (-not $best) { Fail 'recording-file-not-found' }
  # Park the recorder minimized again and hand focus back to the workbench.
  try { if ($win) { $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Minimized) } } catch { }
  try { [void][Win32.Fg]::SetForegroundWindow($fg) } catch { }
  Out-Result @{ ok = $true; stoppedAt = (ToMs $stopped); path = $best.FullName }
}
else { Fail 'unknown-action' }
