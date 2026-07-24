<#
  Deadman Rises - MANUAL installer (the VERIFIED install path).

  Reproduces the tested working install exactly:
    1. Copies the engine scripts (scripts/*.js + scripts/*.ps1) to  ~/.claude/deadman/
    2. Copies the skill                                          to  ~/.claude/skills/deadman/SKILL.md
    3. PRINTS the settings.json blocks (statusLine + hooks) for you to MERGE by hand.

  It DELIBERATELY does not edit settings.json. You paste the printed blocks into
  ~/.claude/settings.json yourself, then restart Claude Code so they load.

  State always lives at ~/.claude/deadman/ (the scripts hardcode os.homedir()),
  so this installer just reproduces that layout.

  Usage:
    powershell -ExecutionPolicy Bypass -File install.ps1
    powershell -ExecutionPolicy Bypass -File install.ps1 -Node "D:/nodejs/node.exe"

  -Node : ABSOLUTE path to the node.exe that Claude Code will run for the hooks and
          status line. If omitted, node is auto-detected from your PATH. Pass it
          only if node is not on PATH. Use forward slashes: on Windows these
          commands run through Git Bash, which strips unquoted backslashes.
#>
param(
  [string]$Node
)
$ErrorActionPreference = 'Stop'

# --- resolve node: explicit -Node, else auto-detect from PATH, else bare 'node' ---
if (-not $Node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) {
    $Node = $cmd.Source
  } else {
    $Node = 'node'
    Write-Host 'node not found on PATH - using bare "node" in the printed commands' -ForegroundColor Yellow
    Write-Host '  (assumes node is on PATH for the shell Claude Code spawns). Pass -Node to override.' -ForegroundColor Yellow
  }
}

$src       = $PSScriptRoot
$homeDir   = $env:USERPROFILE
$dest      = Join-Path $homeDir '.claude\deadman'
$skillDest = Join-Path $homeDir '.claude\skills\deadman'

Write-Host ''
Write-Host 'Deadman Rises - manual install' -ForegroundColor Cyan
Write-Host '=============================='

# --- 1. copy engine scripts -> ~/.claude/deadman/ ---
New-Item -ItemType Directory -Force -Path $dest | Out-Null
Copy-Item -Path (Join-Path $src 'scripts\*.js')  -Destination $dest -Force
Copy-Item -Path (Join-Path $src 'scripts\*.ps1') -Destination $dest -Force
Write-Host ("Copied engine scripts -> " + $dest)

# --- 2. copy the skill -> ~/.claude/skills/deadman/SKILL.md ---
New-Item -ItemType Directory -Force -Path $skillDest | Out-Null
Copy-Item -Path (Join-Path $src 'skills\deadman\SKILL.md') -Destination (Join-Path $skillDest 'SKILL.md') -Force
Write-Host ("Copied skill          -> " + (Join-Path $skillDest 'SKILL.md'))

# --- node sanity check (warn only; the path is for the printed commands) ---
if ($Node -ne 'node' -and -not (Test-Path $Node)) {
  Write-Host ''
  Write-Host ("WARNING: node not found at $Node") -ForegroundColor Yellow
  Write-Host '  Re-run with -Node pointing at your node.exe, OR edit the paths in the'
  Write-Host '  printed settings blocks below before pasting them.' -ForegroundColor Yellow
}

# --- 3. print the settings.json blocks (forward slashes for Git Bash) ---
$nodeFwd = $Node -replace '\\','/'
$destFwd = $dest -replace '\\','/'

$types = @(
  'rate_limit','overloaded','server_error','authentication_failed','oauth_org_not_allowed',
  'billing_error','invalid_request','model_not_found','max_output_tokens','unknown'
)
$sf = ($types | ForEach-Object {
  '      { "matcher": "' + $_ + '", "hooks": [ { "type": "command", "command": "' + $nodeFwd + ' ' + $destFwd + '/diagnose.js ' + $_ + '" } ] }'
}) -join ",`n"

$statusLine = @"
  "statusLine": {
    "type": "command",
    "command": "$nodeFwd $destFwd/statusline.js",
    "padding": 0
  }
"@

$hooks = @"
  "hooks": {
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "$nodeFwd $destFwd/deathwatch.js" } ] }
    ],
    "PostToolUse": [
      { "matcher": "*", "hooks": [ { "type": "command", "command": "$nodeFwd $destFwd/deathwatch.js" } ] }
    ],
    "StopFailure": [
$sf
    ]
  }
"@

Write-Host ''
Write-Host 'NEXT STEP - merge these into ~/.claude/settings.json (top-level keys):' -ForegroundColor Green
Write-Host '--------------------------------------------------------------------'
Write-Host '# statusLine (Death Watch telemetry + usage line):'
Write-Host $statusLine
Write-Host ''
Write-Host '# hooks (Death Watch auto-arm + Failure Intelligence coroner):'
Write-Host $hooks
Write-Host '--------------------------------------------------------------------'
Write-Host ''
Write-Host 'If your settings.json already has a "hooks" block, MERGE these event arrays' -ForegroundColor Green
Write-Host 'into it rather than replacing the whole block. Then RESTART Claude Code.'
Write-Host ''
Write-Host 'Optional Windows durability (see README.md / SECURITY.md):'
Write-Host ("  Reboot helper:  powershell -ExecutionPolicy Bypass -File " + (Join-Path $dest 'install-helper.ps1'))
Write-Host ''
Write-Host 'Done. The deadman skill also works standalone via /deadman without the hooks.' -ForegroundColor Cyan
