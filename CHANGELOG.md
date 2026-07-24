# Changelog

All notable changes to Deadman Rises are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-07-23

First packaged release. The engine was built and tested standalone under
`~/.claude/deadman/`; this release wraps it as a distributable plugin plus a
verified manual installer. No engine behavior changed in packaging.

### The Grave (durable state)
- `grave.js` - a single atomically-written `grave.json` is the source of truth
  for what is armed, in which generation, for which session, and what happened
  last. Whole-object temp-plus-rename writes: a crash leaves either the old or
  the new complete file, never a torn one.
- CLI surface: `init | read | set | addrise | claim | rearm | rest | clear`,
  plus a module API (`readGrave`, `writeGrave`, `claimSeal`, `setPath`, ...).
- Emits a derived `armed.json` shim on every write so the status line and Death
  Watch hook read a stable debounce contract.

### Grave Seal (one-winner guard)
- Compare-and-set `claim <role>@gen<N> <N>` returning `WON | LOST | STALE |
  TAKEOVER`, so First, Second, and Third Rise (and manual-vs-auto) never both
  continue the same generation. Includes claimed-then-died failover (TAKEOVER)
  and genuine-completion dedup (LOST).

### Failure Intelligence + Third Rise
- `diagnose.js` - a `StopFailure` hook that records the classified API-error
  type into `grave.last_failure` (the one signal telemetry alone cannot
  recover: auth vs billing vs overload look identical in usage numbers).
  Write-only, session-guarded, always exits 0. Ten failure categories.
- A fired Rise reads `last_failure` and routes recovery: re-arm after the real
  reset (rate_limit), bounded backoff for overloaded/server_error, stop-and-ask
  for auth/billing, pause-never-bypass for permission blocks. A Third Rise is
  armed for the next window when Life is not yet back.

### Rise echelon + Endless mode
- First Rise at the exact Resurrection Time; Second Rise at +10 minutes (covers
  a primary shot firing into a still-limited API and dying).
- Endless (loop) mode: each successful resurrection re-arms the next generation
  BEFORE resuming work, chaining one-shots across 5-hour windows.
- Soul mode: for exhausted paid windows, arm then stop completely until the
  reset fires.

### Death Watch (hands-free auto-equip)
- `statusline.js` - the only reader of live usage; writes `usage.json`
  (5h/7d %, resets_at, session block) and renders a compact usage line.
- `deathwatch.js` - a `UserPromptSubmit` + `PostToolUse` hook that injects an
  auto-arm instruction when the 5-hour window crosses 80% and this window is
  not already armed. Debounced on the window's `resets_at`.

### Status
- `status.js` - deterministic, no-network renderer for `/deadman status`
  (Grave + Life + Resurrection Time + pending Rises + mode + last recovery +
  last failure).

### Windows durability (optional)
- `keepawake.js` + `keepawake-hold.ps1` - keep-awake lease via
  `SetThreadExecutionState` (system stays awake while armed; display may still
  sleep; does not block user-initiated sleep/lid-close).
- `deadman-helper.js` + `install-helper.ps1` / `uninstall-helper.ps1` - a
  per-user logon task that resumes an armed, overdue, unresolved session after
  a reboot, in a SAFE permission mode (`acceptEdits`) that pauses on gated
  actions and never bypasses permissions silently.

### Packaging
- Native plugin manifest (`.claude-plugin/plugin.json`) and `hooks/hooks.json`
  wired with `${CLAUDE_PLUGIN_ROOT}` (structural/beta path).
- Verified manual installer (`install.ps1` / `uninstall.ps1`) that reproduces
  the tested install and prints the exact `settings.json` blocks to merge.
- `bin/deadman-status` and `bin/deadman-test` launchers.
- Tests copied verbatim (`grave`, `diagnose`, `status`, `statusline.session`)
  with a sandboxed `run-tests.js` runner: 67 assertions, all passing.
