<#
  Deadman Rises - uninstaller for the MANUAL install.

  By default this removes the engine scripts and the skill but PRESERVES your
  Grave state (grave.json / usage.json / armed.json / *.log / *.pid) so a later
  reinstall keeps history. Pass -Purge to delete the entire ~/.claude/deadman/
  directory including state.

  It also (best-effort):
    - releases any keep-awake lease,
    - removes the reboot logon task (DeadmanRises), if registered.

  It does NOT edit settings.json - it prints a reminder of what to remove.

  Usage:
    powershell -ExecutionPolicy Bypass -File uninstall.ps1
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge
    powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Node "D:/nodejs/node.exe"
#>
param(
  [switch]$Purge,
  [string]$Node
)
$ErrorActionPreference = 'Continue'
if (-not $Node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $Node = $cmd.Source } else { $Node = 'node' }
}

$homeDir   = $env:USERPROFILE
$dest      = Join-Path $homeDir '.claude\deadman'
$skillDest = Join-Path $homeDir '.claude\skills\deadman'

Write-Host ''
Write-Host 'Deadman Rises - uninstall' -ForegroundColor Cyan
Write-Host '========================='

# --- best-effort: release keep-awake lease ---
if ((Test-Path $Node) -and (Test-Path (Join-Path $dest 'keepawake.js'))) {
  try { & $Node (Join-Path $dest 'keepawake.js') release | Out-Null } catch {}
}

# --- best-effort: remove reboot logon task ---
try {
  Unregister-ScheduledTask -TaskName 'DeadmanRises' -Confirm:$false -ErrorAction Stop
  Write-Host 'Removed reboot logon task (DeadmanRises).'
} catch {
  Write-Host 'No reboot logon task to remove (or already removed).'
}

# --- remove code (and, with -Purge, state) ---
if ($Purge) {
  if (Test-Path $dest) { Remove-Item -Path $dest -Recurse -Force }
  Write-Host ("Purged (code + state): " + $dest)
} else {
  $codeFiles = @(
    'grave.js','diagnose.js','status.js','statusline.js','deathwatch.js',
    'keepawake.js','keepawake-hold.ps1','deadman-helper.js','install-helper.ps1','uninstall-helper.ps1'
  )
  foreach ($f in $codeFiles) {
    $p = Join-Path $dest $f
    if (Test-Path $p) { Remove-Item -Path $p -Force }
  }
  Write-Host ("Removed engine scripts from " + $dest + " (state preserved; use -Purge to delete it too).")
}

# --- remove the skill ---
$skillFile = Join-Path $skillDest 'SKILL.md'
if (Test-Path $skillFile) { Remove-Item -Path $skillFile -Force }
if ((Test-Path $skillDest) -and -not (Get-ChildItem -Path $skillDest -Force | Select-Object -First 1)) {
  Remove-Item -Path $skillDest -Force
}
Write-Host ("Removed skill: " + $skillFile)

# --- settings reminder ---
Write-Host ''
Write-Host 'FINAL STEP - remove these from ~/.claude/settings.json by hand:' -ForegroundColor Green
Write-Host '  - the "statusLine" block that points at deadman/statusline.js'
Write-Host '  - the "UserPromptSubmit", "PostToolUse", and "StopFailure" hooks that point at'
Write-Host '    deadman/deathwatch.js and deadman/diagnose.js'
Write-Host 'Then restart Claude Code.'
Write-Host ''
Write-Host 'Done.' -ForegroundColor Cyan
