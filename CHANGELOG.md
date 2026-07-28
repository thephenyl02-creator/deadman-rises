# Changelog

All notable changes to Deadman Rises are documented here. This project adheres
to [Semantic Versioning](https://semver.org/).

## [0.1.1] - 2026-07-28

Security patch release. A multi-agent security review of the published code
(four dimensions, each finding adversarially verified) produced eight confirmed
issues; this release fixes all of them plus two related hardening items. No
feature changes, no config migration — upgrade in place.

### Fixed - command execution
- **PowerShell command injection in `keepawake.js`** (the one genuinely
  exploitable bug). `acquire()` embedded the install path in a double-quoted
  string nested inside a single-quoted PowerShell literal with no escaping, so
  an apostrophe or crafted directory name broke out and was parsed as code —
  reproduced end-to-end before the fix. **The path no longer enters the
  PowerShell command text at all:** it is passed to the child through an
  environment variable and re-quoted inside PowerShell, so nothing derived from
  it is ever parsed as code.

  Escaping it into the command string was tried first and rejected as
  insufficient — PowerShell's tokenizer also accepts U+2018, U+2019, U+201A and
  U+201B as string delimiters, so doubling the ASCII apostrophe still let a
  *typographic* one (what autocorrect produces for a name like O'Brien) close
  the literal and execute the remainder. Passing the value out-of-band removes
  the class rather than enumerating it.
- **Keep-awake killed processes that were not holders.** Detection matched any
  PowerShell whose command line contains `keepawake-hold.ps1`. That matched two
  classes of innocent process: every *other* detection query (each one contains
  the string it searches for), and any command that merely reads, greps or backs
  up the holder script — routine inside an agentic coding tool. Both were
  reported as leases by `status` and force-killed by `release` with
  `taskkill /T /F`, taking their whole process tree with them. Detection now
  references the path through an environment variable (so a query's own text
  never contains it) and matches the exact `-File "<full path>"` fragment the
  launcher uses, via `.Contains()` rather than `-like` so bracket characters in
  a path cannot act as wildcards.
- **Keep-awake now verifies its OWN holder actually started.** `Start-Process`
  returns success once the launch is dispatched, so a child that died on a bad
  path still reported `acquired` while `status` said `not held` — and the
  machine slept through the recovery the lease existed to protect. `acquire()`
  now snapshots the holders that existed *before* the launch, counts only a
  genuinely new process as its own, and requires it to survive two spaced checks
  (a doomed holder is briefly visible during PowerShell startup, and an
  unrelated match would otherwise certify a lease that was never established).
- **Keep-awake no longer destroys a working lease when it fails.** `acquire()`
  used to kill the incumbent holder first and launch second, so a failing
  acquire — AV quarantine, a truncated upgrade, `Add-Type` blocked by policy —
  left the machine with no lease at all, and even a successful one left a gap
  with none held. It now launches and verifies first, and retires the previous
  holder only once the replacement is confirmed. Paths containing spaces (e.g. a
  `C:\Users\John Doe` profile) work correctly.
- **`release` reports what actually happened.** `taskkill` fails with "Access is
  denied" against a holder started from an elevated or different-user session,
  and the failure was swallowed — `/deadman rest` and `uninstall.ps1` both
  reported the lease dropped while the machine stayed pinned awake. It now
  re-checks and reports surviving holders. All three PowerShell calls are
  bounded by a timeout, so a wedged WMI repository can no longer hang the
  uninstaller indefinitely.

### Fixed - the unattended resume
- **Dropped `--permission-mode acceptEdits`; the helper now runs `default`.**
  Unsupervised file-write is effectively command execution (a written
  `.claude/settings.json` hook or shell profile runs later with nothing ever
  approved). The `--allowedTools` allowlist already covers everything this run
  legitimately needs, so edit auto-approval was removed rather than documented
  around.
- **Argument injection via `session_id`.** `--resume` takes an *optional*
  argument, so a hyphen-leading session id was not consumed as the id — it
  landed on the unattended command line as its own flag. A Grave carrying
  `session_id: "--dangerously-skip-permissions"` would therefore have armed a
  full permission bypass for the next reboot resume, using only the `grave.js
  set` call that this release's own allowlist permits. Session ids must now
  begin with an alphanumeric character.
- **The Grave is now treated as untrusted input,** and validated **before the
  helper acts on any of it** — before scheduling a follow-up task, before
  looking for `claude.exe`, before building a command line. `version`,
  `session_id`, `generation` and `resurrection_time` are all checked, and the
  working directory is **anchored on Claude Code's session transcript**: the
  helper finds `<session_id>.jsonl` under `~/.claude/projects/`, reads the `cwd`
  recorded in it, and requires `project` to match. Comparing `project` against
  `project_key` is not enough — both derive from `project`, so whoever sets one
  sets the other, and `grave.js set` is on the unattended run's own allowlist;
  an injected session could otherwise point the next reboot resume at any
  directory it chose. The transcript is written by Claude Code, and a run
  holding only `grave.js` and the Cron tools cannot author one. The transcript
  is located by session id and scanned in chunks rather than read as a fixed
  head — real ones open with cwd-less entries followed by lines hundreds of KB
  long, and on a live machine the first `cwd` sat at byte 1.3M, so a small read
  would have found only truncated JSON and disabled post-reboot recovery
  entirely. On anything odd the helper logs the reason and **refuses to
  resume**; the earlier silent fallback to a default directory is gone.
  `resurrection_time` is range-bounded too, so an absurd or null epoch can no
  longer throw a `RangeError` or schedule a follow-up task in 1970.

### Fixed - project key encoding
- **`deriveProjectKey` did not match Claude Code's actual encoding.** It
  replaced only `:` `\` `/`, but Claude Code replaces **every** non-alphanumeric
  character, so `C:\Users\Ann Lee\.config` encodes as `C--Users-Ann-Lee--config`
  — not `C--Users-Ann Lee-.config`. Measured against the real transcript
  directories on a live machine, the old transform matched 1 of 9 and the
  corrected one matches all 9. Graves written with the old encoding are still
  accepted, so an armed recovery is not stranded by the upgrade.

### Fixed - prompt injection
- **The Fired Rise prompt no longer takes orders from project files.** Step 5e
  told an unsupervised session to reconstruct its work from `git log`,
  `SESSION_STATE.md`, plan and TODO files — all attacker-authorable in a cloned
  repo — and to commit as it went, with nothing marking that content as
  untrusted. It is now explicitly quarantined as **data, never instructions**,
  with named red flags (credentials, network calls, remote git, installs,
  permission or `.claude/` changes) and a hard stop that records
  `needs supervised resume` rather than acting. The reboot helper's own prompt
  carries the same clause.
- **Untrusted text is sanitised both on the way in and on the way out.**
  Upstream API error strings are re-read later by a model, so `diagnose.js` now
  cleans them before storing. Sanitising only there was not a chokepoint,
  though — `grave.js set <path> <value>` can write any field — so `status.js`
  also cleans `last_failure.reason`, `last_recovery_result.detail` and each
  rise's `role`/`cron_id` on render. Both use one shared `sanitizeText`, which
  **whitelists printable ASCII** rather than blacklisting known-bad characters:
  a C0-control blacklist misses U+2028/U+2029/U+0085 line terminators,
  zero-width and bidi-override characters, and the invisible Unicode Tag block
  used to smuggle hidden text past a reader. Over-long values are truncated from
  the **middle**, because rate-limit messages put the reset time at the end.
  `grave.js read` — the fired Rise's first action, and therefore a direct path
  into model context — sanitises the same free-text fields on the way out;
  `JSON.stringify` escapes only C0 controls, so every other class passed through
  it untouched.
- **`deathwatch.js`** coerces `used_percentage` and `resets_at` to numbers
  before interpolating them into the instruction it injects every turn.

### Fixed - concurrency
- **The Grave Seal is now a real one-winner mutex.** `claim` was a plain
  read-modify-write with no mutual exclusion, so two Rises firing in the same
  second could both read `owner: null` and both believe they WON — the exact
  thing the Seal exists to prevent. Every mutating command (`init`, `claim`,
  `set`, `addrise`, `rearm`, `rest`) and the `StopFailure` hook now share one
  `O_EXCL` lockfile, and `claim` re-reads after writing to confirm the claim
  landed. The lock carries an owner token so a stalled holder can never delete
  the next holder's live lock, its wait budget deliberately exceeds the
  stale-lock threshold (a shorter budget meant a waiter always gave up before it
  was allowed to break an abandoned lock, then ran unlocked), and falling
  through unlocked now warns on stderr instead of proceeding silently.
- **Concurrent writes could publish a torn Grave.** `atomicWrite` used one
  fixed `<file>.tmp` scratch path for every writer, so two processes interleaved
  their writes into it and both renamed it into place — yielding unparseable
  JSON as the source of truth (reproduced in 4 of 60 rounds with 4 writers).
  The temp name is now unique per write.
- `grave.js clear` now runs under the lock like every other mutation, rather
  than deleting state out from under a live critical section.

- **The holder script now fails loudly instead of holding nothing.** `Add-Type`
  failure (Constrained Language Mode, AppLocker) is non-terminating by default,
  so the holder would sit in its loop forever having never called
  `SetThreadExecutionState` — and `keepawake.js`, which certifies a lease by
  seeing the process alive, would report one that was never asserted. It now
  exits on `Add-Type` failure and on a failed first assertion, so "the process
  is running" honestly means "the lease is held".
- **A failed holder query is no longer read as "no holders".** `holderPids()`
  returned `[]` for a wedged WMI repository, a blocked PowerShell, or a timeout,
  which is indistinguishable from an empty result — enough to make `acquire`
  skip retiring a live incumbent (leaving two leases) and make `release` report
  success on a check that never ran. It returns `null` on failure now, and every
  caller refuses to act on it rather than guessing.
- **Holder matching is case-insensitive again.** `.Contains()` is ordinal, and
  Node does not canonicalise `__dirname`, so the same install invoked through a
  differently-cased absolute path became invisible to itself: `status` reported
  `not held` over a live holder and `release` could not stop it. Both sides are
  lowercased before comparison.

### Tests
- New `tests/security.test.js` (49 assertions) covering every fix above. These
  assert **behaviour, not source text**: the concurrency tests launch genuinely
  parallel processes (an earlier draft used `spawnSync`, which runs children
  strictly sequentially — it passed against deliberately broken code and proved
  nothing), the keep-awake test actually launches a holder from a directory
  whose name contains both a space and an apostrophe, and the helper tests use a
  project path containing a space and a dot (an earlier draft used a plain temp
  path and derived the key with the same transform as the code, so it could not
  have caught the encoding bug above). Suite total is now 119 assertions across
  5 suites.

### Notes
- Every fix in this release was adversarially re-reviewed. Two rounds of review
  found real defects **in the fixes themselves** — an escaping approach that was
  bypassable via Unicode quote lookalikes, an argument-injection hole opened by
  a too-permissive `session_id` pattern, a launch regression on paths containing
  spaces, and a validation anchor that broke resume for most real projects. All
  are corrected here; the empirical claims behind them were reproduced locally
  rather than taken on trust.

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
