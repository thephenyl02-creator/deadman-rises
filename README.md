# Deadman Rises

**A dead-man's switch for Claude Code.** When a long session burns 100% of its
usage and stalls until the window resets, Deadman Rises resumes the work for you
- automatically, at the exact reset time, from where you left off. You arm it
once; it survives the stall and rises again on the other side.

The surface is one command (`/deadman`). All the complexity - durable state, a
one-winner claim protocol, failure classification, retry echelons, hands-free
auto-arming - lives in a hidden engine of small Node scripts.

```
/deadman                 # arm for this session's 5h reset, then keep working
/deadman at 3:40am       # arm for an exact time
/deadman endless         # loop across usage windows (overnight marathons)
/deadman status          # what's armed, Life %, pending Rises, last failure
/deadman rest            # Rest in Peace (disarm) - ALWAYS do this when done
```

> **Requires** Claude Code with `CronCreate`/`CronList` (in-session scheduling),
> Node.js, and - for hands-free Death Watch auto-arm - a Claude.ai **Pro/Max**
> session (see [Honest limits](#honest-limits)).

---

## The themed model

Deadman uses a consistent life-and-death metaphor. Every term maps to a concrete
mechanism:

| Term | What it actually is |
|------|---------------------|
| **Life** | Your live usage headroom - the 5-hour and 7-day windows (`used_percentage` + reset time). "Life is back" = the window reset and the API answers again. |
| **The Grave** | `grave.json`, the durable state file - the single source of truth for what's armed, in which generation, for which session. Atomic writes. |
| **Grave Seal** | A one-winner compare-and-set claim on the Grave, so two Rises never both continue the same generation. |
| **Resurrection Time** | The epoch a Rise is scheduled to fire - the exact moment Life is expected back. |
| **First / Second / Third Rise** | The retry echelon. First fires at the Resurrection Time; Second at +10 min (covers a shot firing into a still-dead API); Third is armed by a live Rise when Life still isn't back. |
| **Death Watch** | The hands-free watcher. It sees usage climbing and arms Deadman for you before you run out. |
| **Last Breath** | The Death Watch threshold - 80% of the 5-hour window. Crossing it triggers auto-arm. |
| **Endless Rise** | Loop mode - each successful resurrection re-arms the next generation before resuming work, chaining across windows. |
| **Soul Sacrifice** | `soul` mode - for an exhausted **paid** window where every token costs money: arm the shots, then stop completely and do nothing until the reset fires. |
| **Rest in Peace** | Disarm. Deletes the crons, settles the Grave, drops any keep-awake lease. Mandatory on completion. |

---

## How it works (30-second version)

1. **Only the model can arm.** `CronCreate` is a model tool - no script can call
   it. So the engine's job is to persist facts to disk that a *live turn* reads
   and acts on.
2. **You arm** (or Death Watch arms for you). Two one-shot crons are scheduled:
   **First Rise** at the Resurrection Time, **Second Rise** at +10 min. The Grave
   records the generation, session, mode, and Rises.
3. **The session stalls** at the usage limit. The app window stays open.
4. **The reset passes**, the REPL is idle, and a Rise fires. It confirms Life is
   back, claims the **Grave Seal** (so the sibling stands down), deletes the
   other crons, then resumes your work from the project's own records (git log,
   plan files, TODOs).
5. **If Life isn't back yet**, the Rise re-arms a **Third Rise** for the next
   real reset and stands down - no wasted work into a dead API.
6. **When the work is done**, `/deadman rest` disarms everything.

---

## Command surface

| Command | Effect |
|---------|--------|
| `/deadman` | Arm First/Second Rise for this session's 5-hour reset (or now+5h03m if unknown), then continue the current work. |
| `/deadman <hours>` | Arm for now + that many hours. |
| `/deadman at <time>` | Arm for an exact clock time (e.g. `at 3:40am`). A named reset from a limit error beats every assumption. |
| `/deadman watch` | Opt in without arming: Death Watch auto-arms at 80% of the 5h window. **Terminal + Death Watch install only** - falls back to offering an immediate arm elsewhere. |
| `/deadman endless` (alias `loop`) | Endless Rise: re-arm each window before resuming - and the chain **ends itself** when a Rise finds the work complete, so a forgotten chain never wakes forever. `rest` still stops it any time. |
| `/deadman soul` | Soul Sacrifice: arm, report one line, then **stop completely** until the reset - for exhausted paid windows. Combines: `soul endless`. |
| `/deadman status` | Render the Grave + Life (5h/7d %), Resurrection Time, pending Rises, mode, last recovery, last failure; then reconcile against `CronList`. |
| `/deadman test` | Prove the install without touching real work: arm two throwaway probes, confirm they registered, clean up. `--fire` lets them fire once. |
| `/deadman rest` | **Rest in Peace** - disarm all crons, settle the Grave, drop keep-awake. Do this when the planned work finishes. |

Any extra text after the args is captured verbatim as the **task directive** and
embedded in the fired-Rise prompt, so the resumed turn knows what to do.

---

## Auto-equip (Death Watch)

Deadman can arm itself before you run out, once the companion status line + hook
are installed (**terminal only** - the desktop app and web render no status
line, so there is no telemetry there; on those surfaces `/deadman` simply arms
immediately).

**Strictly opt-in per conversation.** The hooks are installed globally, but
Death Watch acts ONLY in a conversation that invoked `/deadman` (any form - arm,
`watch`, `endless`, `soul`). The live conversation's identity comes from the
hook invocation's **own event payload** - never from a shared file another
terminal may have written - and is matched against the Grave's recorded id; no
Grave, a rested Grave, another conversation's Grave, or an event without a
session id all mean it exits silently (fail closed). A conversation that never
asked for deadman is never interrupted. It also ignores any `usage.json` older
than ~10 minutes, so a reading left behind by a dead terminal session can never
trigger an arm days later. When arming, identity is recorded from a turn-local
`session.json` stamp (written by the hook from its own payload) in preference to
`usage.json`, and a Death Watch trigger embeds `--session <id>` outright - the
one acknowledged residual: two conversations mid-turn in the same instant can
still cross-stamp at `init` time (see SKILL notes).

```
statusline.js  --writes-->  usage.json      (the ONLY reader of live usage %)
      |
  deathwatch.js hook reads usage.json each turn / tool call
      |  if 5h >= 80% (Last Breath) AND this window not already armed:
      v
  injects "DEATH WATCH AUTO-EQUIP TRIGGER ..." into the model's context
      |
      v
  the model arms First/Second Rise at the real reset, writes armed.json
  (debounce), and tells you ONE line.
```

Why the two-stage bridge? The live usage % + reset time exist in exactly one
place a script can read them: the status-line command's stdin JSON. And no script
can call `CronCreate`. So `statusline.js` captures the numbers, `deathwatch.js`
reads them each turn and *nudges* the model, and the model does the actual arm.
It's a strong injected instruction - very reliable, but a nudge, not a hard-wired
trigger.

- **Threshold** (80%) and **window** (5-hour) live at the top of `deathwatch.js`.
- **Debounce** is keyed on the window's `resets_at`: armed once per window, then
  silent until it rolls over.
- **`PostToolUse`** runs on every tool call to catch a threshold crossed
  mid-turn during long autonomous runs. If you don't want that per-tool cost,
  install only `UserPromptSubmit` and catch the crossing at the next user turn.

---

## Install

**Prerequisites:** [Claude Code](https://code.claude.com) with in-session
scheduling (`CronCreate`/`CronList`/`CronDelete`), **Node.js** on your `PATH`, and
- for hands-free Death Watch auto-arm - a Claude.ai **Pro/Max** session.

```bash
git clone https://github.com/thephenyl02-creator/deadman-rises.git
cd deadman-rises
```

There are two install paths. **The manual installer is the verified one** - it
reproduces the exact install these scripts were built and tested against. The
native plugin is structural/beta.

### Path 1 - Manual installer (verified)

Pick your mode by surface:

| Mode | Command | Works on | What `/deadman` does |
|------|---------|----------|----------------------|
| **Core** (default) | `powershell -ExecutionPolicy Bypass -File install.ps1` | **Terminal, desktop app, web** | Arms immediately when invoked. Includes the skill, engine, and Failure Intelligence (`StopFailure` hooks). |
| **+ Death Watch** | `powershell -ExecutionPolicy Bypass -File install.ps1 -DeathWatch` | **Terminal only** (needs the status line) | Core, plus hands-free auto-arm at 80% - only in conversations that opted in via `/deadman`. |

Add `-Node "D:/nodejs/node.exe"` to either if node isn't on your PATH.

What it does:

| Step | Action |
|------|--------|
| 1 | Copies `scripts/*.js` + `scripts/*.ps1` to `~/.claude/deadman/`. |
| 2 | Copies `skills/deadman/SKILL.md` to `~/.claude/skills/deadman/SKILL.md`. |
| 3 | **Prints** the settings blocks for your mode (Core: `StopFailure` hooks only; `-DeathWatch`: also `statusLine` + `UserPromptSubmit`/`PostToolUse`) for you to **merge by hand** into `~/.claude/settings.json`. |

It deliberately does **not** edit `settings.json`. Paste the printed blocks
yourself, then **restart Claude Code**.

- `-Node` is **auto-detected from your PATH** when omitted; pass it only if node
  isn't on PATH (`which node` in Git Bash to find it). Paths use forward slashes
  on purpose: on Windows these commands run through Git Bash, which strips
  unquoted backslashes.
- If your `settings.json` already has a `hooks` block, merge the event arrays
  into it rather than replacing it.
- Not sure which mode? **Core.** You can re-run with `-DeathWatch` later; the
  hooks are safe everywhere (opt-in gated), Core just spares non-terminal
  surfaces config that can't do anything there.

### Path 2 - Native plugin (structural / beta)

The package is also a valid Claude Code plugin. Load it directly:

```bash
claude --plugin-dir /path/to/deadman-rises
```

`.claude-plugin/plugin.json` + `hooks/hooks.json` wire the `UserPromptSubmit`,
`PostToolUse`, and `StopFailure` hooks with `${CLAUDE_PLUGIN_ROOT}/scripts/...`,
and the skill loads as `/deadman-rises:deadman`.

> **One thing the plugin cannot do:** the **status line is a user-settings
> field, not a plugin hook** (Claude Code plugins only ship the `agent` /
> `subagentStatusLine` settings keys). Death Watch's telemetry comes from
> `statusline.js`, so **you must add the `statusLine` line to your
> `~/.claude/settings.json` manually** even with the plugin - otherwise
> `usage.json` is never written and `deathwatch.js` stays silent (auto-arm falls
> back to manual `/deadman`; nothing breaks). Add:
>
> ```json
> "statusLine": {
>   "type": "command",
>   "command": "node <plugin-root>/scripts/statusline.js",
>   "padding": 0
> }
> ```
>
> The plugin hooks assume `node` is on your `PATH`.

Because of that gap and the beta status of the wiring, **prefer the manual
installer for a fully working Death Watch.** The plugin path is best for trying
the skill and the Failure-Intelligence hooks.

---

## Windows durability

Out of the box, Deadman survives a usage stall **with the app window open**. Two
optional Windows helpers extend that:

| Helper | What it buys you | Install |
|--------|------------------|---------|
| **Keep-awake** (`keepawake.js` + `keepawake-hold.ps1`) | The system won't sleep while a recovery is armed (display may still sleep). Opt-in via the Grave's `keep_awake.policy`; released on `rest`. | Set policy + `node ~/.claude/deadman/keepawake.js acquire` after arming. |
| **Reboot helper** (`deadman-helper.js` + `install-helper.ps1`) | Resumes an armed, overdue, unresolved session **after a full restart** via a per-user logon task. | `powershell -ExecutionPolicy Bypass -File ~/.claude/deadman/install-helper.ps1` (once). |

**Security note (important).** The reboot helper resumes in a **safe permission
mode** (`default`): nothing is auto-approved beyond a small `--allowedTools`
allowlist — deadman's own Grave bookkeeping and the Cron tools — which is all
this run needs. Everything else, **file edits included**, still requires
approval, so an unattended resume that hits a gate **pauses rather than running
unsupervised** and defers real project work to a supervised session. It **never
bypasses permissions silently**; `bypassPermissions` is an explicit, documented
opt-in with a stated risk. The Grave is treated as untrusted input and validated
before any of it reaches the command line. It has a `--dry-run`, a 25-minute
watchdog, and only ever launches the highest-versioned bundled `claude.exe`.
Full details in [SECURITY.md](SECURITY.md).

---

## Honest limits

Deadman is deliberately transparent about what it can't do:

| Limit | Detail |
|-------|--------|
| **Telemetry is Pro/Max-only** | Live `rate_limits` are absent for API-key sessions and before the first API response. Death Watch then stays silent and arming falls back to manual `/deadman`. Nothing breaks. |
| **Only the model can arm** | No script can call `CronCreate`. Auto-arm is a strong *nudge* the model obeys, not a hard trigger. A turn that dies into a *fully* dead API cannot arm a Third Rise - mitigated by arming early (healthy API), the +10 min Second Rise, and the Death Watch nudge. |
| **No cron catch-up** | Crons fire only while the REPL is idle; a fire missed while the machine is asleep/off is **not** replayed. (The reboot helper covers the restart case.) |
| **Session-only by default** | The switch survives a limit stall with the window open, but **not** closing the app or a crash - unless the Windows reboot helper is installed. |
| **Death Watch is terminal-only and opt-in** | It needs the status line (desktop/web render none) and only acts in conversations that invoked `/deadman`. Usage only climbs while you work, so a fully idle, terminal-closed session won't auto-arm. Arm manually up front for those. |
| **Endless is a chain, not a recurring cron** | 5-hour windows don't fit the cron grid, so each fire arms the next window. A broken link (missed fire) ends the chain. A Rise that finds the work complete also ends it deliberately. |
| **Exact reset time needs telemetry** | Without the status line, `/deadman` with no time falls back to now+5h03m — deliberately late (the 5h window is rolling) and self-correcting: any limit error naming the real reset re-arms to the exact minute. |

Alternatives for the cases Deadman doesn't cover: `/loop` runs a prompt on a
fixed interval in a live session; `/schedule` cloud routines survive the app
closing but run in the cloud.

---

## Known issues

- **Phantom scheduled-task chips (Claude Code app UI).** The app may keep
  showing a scheduled-task chip after the underlying session-scoped job fired,
  was deleted, or died with its session — chips can also mislabel one-shots as
  "recurring". This is an app display issue, not deadman state: `CronList` (and
  `/deadman status`, which reconciles against it) is the only truth. Clicking
  stop on a stale chip just sends a message at a job that no longer exists; the
  skill answers those with one combined ledger instead of erroring per id. The
  chips clear on app restart.

---

## Uninstall

```powershell
powershell -ExecutionPolicy Bypass -File uninstall.ps1          # remove code, keep state
powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Purge   # remove code + state
```

It also releases any keep-awake lease and removes the reboot logon task
(best-effort), then prints a reminder to delete the `statusLine` + hook blocks
from `~/.claude/settings.json`. Restart Claude Code afterward. (Plugin users:
just `claude plugin disable` / drop the `--plugin-dir` flag, and remove the
manually-added `statusLine`.)

---

## Package layout

```
deadman-rises/
├── .claude-plugin/plugin.json     # native plugin manifest
├── hooks/hooks.json               # plugin hook wiring (${CLAUDE_PLUGIN_ROOT})
├── skills/deadman/SKILL.md        # the /deadman skill
├── scripts/                       # the engine (copied verbatim)
│   ├── grave.js  diagnose.js  status.js  statusline.js  deathwatch.js
│   ├── keepawake.js  keepawake-hold.ps1
│   └── deadman-helper.js  install-helper.ps1  uninstall-helper.ps1
├── tests/                         # copied tests + sandboxed runner
│   ├── grave.test.js  diagnose.test.js  status.test.js
│   ├── statusline.session.test.js  deathwatch.test.js  security.test.js
│   └── run-tests.js
├── bin/                           # thin launchers (node on PATH)
│   ├── deadman-status  deadman-test
├── install.ps1  uninstall.ps1     # verified manual (un)installer
├── README.md  SECURITY.md  LICENSE  CHANGELOG.md
```

Run the tests any time:

```bash
node tests/run-tests.js      # or:  bin/deadman-test
```

They run fully sandboxed (`HOME`/`USERPROFILE` redirected to a scratch dir), so
your real `~/.claude/deadman/` state is never touched.

---

## License

MIT (c) 2026 Fenil. See [LICENSE](LICENSE).
