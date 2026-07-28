#!/usr/bin/env node
'use strict';
/*
 * deadman / keep-awake lease (Windows). Prevents the SYSTEM from sleeping while a
 * recovery is armed, by holding SetThreadExecutionState in a detached PowerShell
 * process (keepawake-hold.ps1). The lease lives only as long as that process, so
 * releasing = killing it; a crash of the holder drops the lease automatically.
 * Opt-in: the deadman skill only acquires it when the Grave's keep_awake.policy
 * asks for it. Does NOT block user-initiated sleep/lid-close.
 *
 * Identity is by COMMAND LINE, not PID: we find/kill only powershell processes
 * whose command line runs the holder script. No PID file — so a stale PID that
 * Windows has reused can never cause us to kill an unrelated process, and status
 * always reflects a live holder.
 *
 * Usage: node keepawake.js <acquire|release|status>
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const HOLD = path.join(__dirname, 'keepawake-hold.ps1');

// Detection has to be narrow in two directions at once.
//
// It must not match ITSELF: a query's own command line necessarily mentions
// whatever it searches for, so an earlier version that looked for the literal
// "keepawake-hold.ps1" found every *other* concurrent query and called it a
// holder — `status` invented leases, and `release` force-killed those innocent
// processes with taskkill /T, taking their whole process tree. Referencing the
// path through $env: keeps the literal out of the query's own text.
//
// It must not match a PASSER-BY either: `-like '*-File*'` is nearly vacuous
// (Out-File, -FilePath, even a path fragment like my-files satisfies it), so any
// command that merely reads or greps the holder script — routine inside an
// agentic coding tool — was a kill target. Matching the exact
// `-File "<full path>"` fragment we launch with pins it to a real holder.
// .Contains() rather than -like: a path may contain [ ] which are -like
// wildcards.
// Compared lowercased on both sides: Windows paths are case-insensitive, but
// .Contains() is ordinal and Node does not canonicalise __dirname, so invoking
// the same install via a differently-cased absolute path would otherwise make
// it invisible to itself — status would say "not held" over a live holder, and
// release would leave the machine pinned awake with no way to stop it.
const PS_FIND =
  '$needle = (\'-File "\' + $env:' + 'DEADMAN_KEEPAWAKE_HOLD' + " + '\"').ToLowerInvariant(); " +
  'Get-CimInstance Win32_Process -Filter "Name=\'powershell.exe\'" | ' +
  'Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($needle) } | ' +
  'Select-Object -ExpandProperty ProcessId';

// The install path never enters the PowerShell command text. It is handed to the
// child through an environment variable and re-quoted INSIDE PowerShell, so
// nothing derived from the path is ever parsed as code.
//
// Escaping the path into the command string was tried and is not sufficient:
// PowerShell's tokenizer accepts U+2018, U+2019, U+201A and U+201B as string
// delimiters too, so doubling the ASCII apostrophe still lets a typographic
// one (exactly what autocorrect produces for a name like O'Brien) close the
// literal and execute the remainder. Passing the value out-of-band removes the
// whole class instead of enumerating it.
const HOLD_ENV = 'DEADMAN_KEEPAWAKE_HOLD';
// Constant command text: the only variable part is the $env: lookup, and the
// explicit inner double quotes keep a path containing spaces as ONE argument
// (Start-Process joins an -ArgumentList array with bare spaces and adds no
// quoting of its own — a spaced path passed that way is silently truncated).
// Windows forbids '"' in file names, so double-quoting is always safe here.
const LAUNCH_CMD =
  'Start-Process powershell -WindowStyle Hidden -ArgumentList ' +
  "('-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"' + " +
  '$env:' + HOLD_ENV + " + '\"')";

function sleepMs(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

function psEnv() {
  const env = Object.assign({}, process.env);
  env[HOLD_ENV] = HOLD;
  return env;
}

// PIDs of live powershell holders running our script. Each call spawns a full
// PowerShell + Get-CimInstance and costs on the order of seconds — call it
// sparingly and reuse the result. A wedged WMI repository is a routine Windows
// failure, so the query is bounded; a timeout returns [] like any other failure.
// Returns an array of PIDs, or NULL when the query itself failed (wedged WMI,
// blocked PowerShell, timeout). The distinction matters: collapsing a failed
// query to [] reads as "no holders", which would make acquire() skip retiring a
// live incumbent (leaving two leases) and make release() claim success on the
// strength of a check that never ran.
function holderPids() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', PS_FIND],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: psEnv(), timeout: 20000, killSignal: 'SIGKILL' });
    return String(out || '').split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
  } catch (e) { return null; }
}

function kill(pids) {
  for (const pid of pids) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 20000, killSignal: 'SIGKILL' }); }
    catch (e) { /* verified below rather than trusted */ }
  }
}

function release() {
  const pids = holderPids();
  if (pids === null) { console.log('keepawake: cannot query holders; nothing released'); return; }
  if (!pids.length) { console.log('keepawake: nothing held'); return; }
  kill(pids);
  // taskkill fails with "Access is denied" against a holder started from an
  // elevated or different-user session, so the outcome is checked rather than
  // assumed — reporting a dropped lease that is still pinning the machine awake
  // would be worse than reporting the failure.
  const left = holderPids();
  if (left === null) { console.log('keepawake: kill sent, but could not confirm (' + pids.join(',') + ')'); return; }
  if (!left.length) { console.log('keepawake: released (' + pids.join(',') + ')'); return; }
  console.log('keepawake: release FAILED, still held (' + left.join(',') + ')');
}

function acquire() {
  // Check the holder script BEFORE releasing: a broken or partial install must
  // not tear down a lease that is currently doing its job.
  let ok = false;
  try { ok = fs.statSync(HOLD).isFile(); } catch (e) { ok = false; }
  if (!ok) { console.log('keepawake: holder script missing (' + HOLD + ')'); return; }

  // Launch FIRST and verify, then retire the incumbent. Releasing up front
  // meant a failing acquire (AV quarantine, a truncated upgrade, Add-Type
  // blocked by policy) destroyed a lease that was doing its job and left
  // nothing in its place — and even a successful one left a gap with no lease
  // held. Whatever happens below, the machine is never left unpinned by us.
  const before = holderPids();
  if (before === null) { console.log('keepawake: cannot query holders; not acquiring'); return; }

  // Launch via Start-Process so the holder is a truly INDEPENDENT process that
  // survives this launcher exiting (a plain detached Node spawn on Windows gets
  // torn down when the parent exits, even with unref()).
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', LAUNCH_CMD],
      { stdio: 'ignore', windowsHide: true, env: psEnv(), timeout: 20000, killSignal: 'SIGKILL' });
  } catch (e) { console.log('keepawake: acquire failed (' + e.message + ')'); return; }

  // Start-Process reports success once the launch is DISPATCHED — a child that
  // dies immediately on a bad path also exits 0 here, so success is observed
  // rather than assumed. Only a process that is NEW since `before` counts as
  // ours, and it must still be there on a second look: a doomed holder is
  // briefly visible during PowerShell startup, and an unrelated matching
  // process would otherwise certify a lease we never established.
  const isNew = p => before.indexOf(p) === -1;
  sleepMs(1500);
  const firstAll = holderPids();
  const first = firstAll === null ? [] : firstAll.filter(isNew);
  let mine = [];
  if (first.length) {
    sleepMs(1500);
    const secondAll = holderPids();
    mine = secondAll === null ? [] : secondAll.filter(p => isNew(p) && first.indexOf(p) !== -1);
  }

  if (!mine.length) {
    console.log('keepawake: acquire failed (holder did not stay running)' +
      (before.length ? '; existing lease left intact (' + before.join(',') + ')' : ''));
    return;
  }
  if (before.length) kill(before); // singleton — retire the old holder(s) now
  console.log('keepawake: acquired');
}

function status() {
  const pids = holderPids();
  if (pids === null) { console.log('unknown (holder query failed)'); return; }
  console.log(pids.length ? ('held (' + pids.join(',') + ')') : 'not held');
}

const cmd = process.argv[2];
if (cmd === 'acquire') acquire();
else if (cmd === 'release') release();
else if (cmd === 'status') status();
else { console.error('usage: keepawake.js <acquire|release|status>'); process.exit(1); }
