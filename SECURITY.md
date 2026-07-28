# Security

Deadman Rises runs small local Node and PowerShell scripts that persist state to
disk and, when you wire the hooks, schedule in-session resumes. This document
states exactly what runs, when, where data lives, and how to turn it all off.

## Threat model in one line

The engine is **breadcrumbs on disk that a live Claude turn reads and acts on.**
No script can arm anything or take a privileged action on its own - `CronCreate`
and `--resume` are model/CLI actions. The scripts only read/write JSON and render
text. The one exception that starts a process is the optional Windows reboot
helper, covered below.

## Data locations and what is stored

All state lives under `~/.claude/deadman/` (`os.homedir()`; the scripts hardcode
it, so state is the same no matter where the package is installed).

| File | Written by | Contents |
|------|-----------|----------|
| `grave.json` | `grave.js` | Session id, project path + derived project key, generation, mode, Resurrection Time, the Rise list (roles, cron ids, fire times, status), the Seal (owner + claim time), last recovery result, last failure (type/reason/epoch), backoff, keep-awake policy. |
| `armed.json` | `grave.js` (derived shim) | `armed_for_resets_at`, `armed_at`, `mode`. Debounce flag only. |
| `usage.json` | `statusline.js` | 5h/7d used-percentage and reset epochs, plus a session block (session id, cwd, project key). |
| `helper.log` | `deadman-helper.js` | Timestamped lines about reboot-helper decisions (skip/resume). |
| `test-result.json` | `/deadman test` probes | Temporary; deleted by the test flow. |
| `grave.json.lock` | `grave.js` | Transient mutex file; holds only an opaque owner token, removed on release. |

`keepawake.js` deliberately writes **no PID file**: it finds its holder by
command line, so a stale PID that Windows has reused can never cause an
unrelated process to be killed.

**No secrets are stored.** No API keys, tokens, passwords, or message content.
The session id is an opaque Claude Code conversation identifier; the cwd/project
key are your working-directory path. Nothing is encrypted because nothing stored
is a credential - but treat `~/.claude/` as private, as you already do for Claude
Code's own session data.

**No network calls.** None of the scripts open a socket, fetch a URL, or phone
home. `status.js` is explicitly a pure, no-network renderer. The only outbound
effect any script has is the reboot helper spawning your local `claude.exe`.

## What each hook executes, and when

You wire these yourself (manual install prints them; the plugin ships them in
`hooks/hooks.json`). Each is a short Node process:

| Hook event | Script | When it runs | What it does |
|-----------|--------|--------------|--------------|
| `UserPromptSubmit` | `deathwatch.js` | Once per user turn | Reads `usage.json`; if 5h >= 80% and this window is not armed, injects a one-shot "auto-arm" instruction into context. Never blocks the turn. |
| `PostToolUse` (`*`) | `deathwatch.js` | After every tool call | Same check, to catch the threshold crossing mid-turn during long autonomous runs. Adds ~tens of ms of Node startup per tool call. |
| `StopFailure` (x10) | `diagnose.js <type>` | When a turn ends on an API error | Records the classified failure type into `grave.last_failure`. Write-only, session-guarded, always exits 0. Its stdout is ignored by Claude Code. |

`deathwatch.js` and `diagnose.js` are defensive by construction: any error path
exits 0 with no output so they can never break a turn or the status line.
`statusline.js` (a user-settings field, not a hook) is the only reader of live
usage and likewise always prints something.

The auto-arm is a **strong injected instruction, not a hard-wired action** - the
model still decides to call `CronCreate`. Arming is cheap and reversible
(disarm = `CronDelete`), which is why the skill treats it as non-gated.

## Reboot helper - permission posture (read this)

`deadman-helper.js` is the only component that can start Claude unattended. It
runs from a per-user Windows logon task (`install-helper.ps1`) and does
**nothing** unless the Grave shows a generation that is armed, past its
Resurrection Time, and not already rested/resolved. When it does resume, it runs:

```
claude.exe --resume <session_id> -p <recovery prompt> \
  --permission-mode default \
  --allowedTools "Bash(node ~/.claude/deadman/grave.js:*) CronCreate CronList CronDelete"
```

- **Default `default`** (set in `deadman-helper.js` as `PERMISSION_MODE`): nothing
  is auto-approved except the tools on the `--allowedTools` list — deadman's own
  Grave bookkeeping and the Cron tools. That is everything this run legitimately
  needs (claim the Seal, re-arm coverage, record state). Every other action,
  **including file edits**, still requires approval, and with no human present it
  does not run: the resume re-arms coverage and defers real project work to a
  supervised session.
- **Why not `acceptEdits`** (used before v0.1.1): unsupervised file-write is
  effectively command execution on this system — a written
  `.claude/settings.json` hook or shell profile runs later without any command
  ever being approved. Since the allowlist already covers the helper's real
  needs, edit auto-approval was removed rather than documented around.
- **The Grave is treated as untrusted input.** Anything running as your user can
  write `grave.json`, so every field is validated **before the helper acts on any
  of it** — before it schedules a follow-up task, looks for `claude.exe`, or
  builds a command line. `session_id` must be alphanumeric-initial (a
  hyphen-leading value would land on the command line as its own flag rather
  than as the id, which is how a tampered Grave could otherwise switch the run
  to full permission bypass); `generation` and `resurrection_time` must be
  integers; `project` must be an existing absolute directory.

  **The working directory is anchored on Claude Code's own session transcript.**
  Comparing `project` against `project_key` would prove nothing — both are
  derived from `project`, so whoever sets one sets the other, and `grave.js set`
  is on the unattended run's own allowlist. Instead the helper locates
  `<session_id>.jsonl` under `~/.claude/projects/`, reads the `cwd` Claude Code
  recorded there, and requires it to equal `project`. That record is written by
  Claude Code, not by deadman, and a session holding only `grave.js` and the
  Cron tools cannot author one. On anything odd the helper logs the reason and
  refuses to resume — it never falls back to a default directory.
- **`bypassPermissions` is an explicit opt-in only.** Changing `PERMISSION_MODE`
  to `bypassPermissions` lets the resumed session run **any command with no
  approval** while you are away. That is a real risk; the code comments say so.
  **Deadman never bypasses permissions silently.**
- A 25-minute watchdog force-kills a hung resume; `stdin` is closed (EOF) to
  avoid a Windows headless hang.
- The helper picks the highest-versioned bundled `claude.exe` under
  `AppData/Roaming/Claude/claude-code/*` - it never runs an arbitrary binary.

The logon task is per-user and needs no admin. It is registered with
`AllowStartIfOnBatteries` and a 30-minute execution limit. Remove it with
`uninstall-helper.ps1` (or the package `uninstall.ps1`).

## Keep-awake - power/battery note

`keepawake.js` spawns a hidden PowerShell holder (`keepawake-hold.ps1`) that
calls `SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED)` every 60s so
the **system** stays awake while a recovery is armed. It deliberately omits
`ES_DISPLAY_REQUIRED`, so the **display can still sleep/lock**, and it does not
override user-initiated sleep or lid-close (Windows design). It is **opt-in**:
the skill only acquires it when the Grave's `keep_awake.policy` asks for it, and
the lease is dropped on `/deadman rest`. Expect higher idle power draw / faster
battery drain while a lease is held - do not leave one held on battery.

Holders are identified by matching the exact `-File "<full path>"` fragment of
their command line, so a process that merely reads or names the holder script is
never mistaken for one (and never killed). Two known limits, both self-correcting
on the next `release`, which kills every match:

- Two `acquire` runs racing in the same ~3-second window can each certify a
  holder, leaving two leases. There is no cross-process mutex by design.
- If the previous holder exits on its own during that window, Windows may reuse
  its PID for the new one; `acquire` then reports failure naming a PID that is
  no longer the incumbent. Re-running `release` then `acquire` resolves it.

## How to disable or fully remove

- **Disable auto-arm only:** remove the `UserPromptSubmit` / `PostToolUse` /
  `StopFailure` hooks (and the `statusLine`) from `~/.claude/settings.json`, or
  disable the plugin. The `/deadman` skill keeps working manually.
- **Remove the reboot helper:** `uninstall-helper.ps1` (unregisters the
  `DeadmanRises` logon task).
- **Drop a keep-awake lease:** `node ~/.claude/deadman/keepawake.js release`.
- **Full uninstall:** run `uninstall.ps1` (preserves state) or
  `uninstall.ps1 -Purge` (deletes `~/.claude/deadman/` including state), then
  remove the `statusLine` + hook blocks from `settings.json`.

## Responsible disclosure

Found a security issue in Deadman Rises? Please report it privately to the author
(the.phenyl02@gmail.com) rather than opening a public issue, and allow a
reasonable window for a fix before any public disclosure.
