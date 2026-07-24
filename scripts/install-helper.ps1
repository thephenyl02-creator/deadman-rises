# deadman / install the reboot startup-helper as a Windows logon task.
# Run once (no admin needed for a per-user logon task):
#   powershell -ExecutionPolicy Bypass -File "$HOME\.claude\deadman\install-helper.ps1"
# Pass -Node "D:/path/node.exe" only if node is not on your PATH.
# This registers a task that runs deadman-helper.js at each logon; the helper does
# NOTHING unless the Grave shows an armed, overdue, unresolved generation.
# Remove with uninstall-helper.ps1.
param([string]$Node)
$ErrorActionPreference = 'Stop'

if (-not $Node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $Node = $cmd.Source }
  else { Write-Error 'node not found on PATH. Re-run with -Node "C:/path/to/node.exe".'; exit 1 }
}
$helper = Join-Path $env:USERPROFILE '.claude\deadman\deadman-helper.js'
if (-not (Test-Path $Node))   { Write-Error "node not found at $Node"; exit 1 }
if (-not (Test-Path $helper)) { Write-Error "helper not found at $helper (run install.ps1 first)"; exit 1 }

$action   = New-ScheduledTaskAction -Execute $Node -Argument "`"$helper`""
$trigger  = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName 'DeadmanRises' -Action $action -Trigger $trigger -Settings $settings `
  -Description 'Deadman Rises: resume an armed Claude Code session after reboot (safe permission mode).' -Force | Out-Null

Write-Output 'DeadmanRises logon task registered. It resumes only when the Grave shows an armed, overdue, unresolved generation.'
