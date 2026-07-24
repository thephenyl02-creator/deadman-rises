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
 * whose command line runs keepawake-hold.ps1. No PID file — so a stale PID that
 * Windows has reused can never cause us to kill an unrelated process, and status
 * always reflects a live holder.
 *
 * Usage: node keepawake.js <acquire|release|status>
 */
const path = require('path');
const { execFileSync } = require('child_process');

const HOLD = path.join(__dirname, 'keepawake-hold.ps1');
const MARK = 'keepawake-hold.ps1';

// PIDs of live powershell holders running our script. Excludes THIS query's own
// process ($PID), whose command line contains MARK inside the filter string.
function holderPids() {
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -like '*${MARK}*' } | Select-Object -ExpandProperty ProcessId`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return String(out || '').split(/\r?\n/).map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0);
  } catch (e) { return []; }
}

function release() {
  const pids = holderPids();
  if (!pids.length) { console.log('keepawake: nothing held'); return; }
  for (const pid of pids) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (e) {} }
  console.log('keepawake: released (' + pids.join(',') + ')');
}

function acquire() {
  release(); // singleton — kill any existing holder(s) first
  // Launch via Start-Process so the holder is a truly INDEPENDENT process that
  // survives this launcher exiting (a plain detached Node spawn on Windows gets
  // torn down when the parent exits, even with unref()).
  const inner = `-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${HOLD}"`;
  const cmd = `Start-Process powershell -WindowStyle Hidden -ArgumentList '${inner}'`;
  try {
    execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', cmd], { stdio: 'ignore', windowsHide: true });
    console.log('keepawake: acquired');
  } catch (e) { console.log('keepawake: acquire failed (' + e.message + ')'); }
}

function status() {
  const pids = holderPids();
  console.log(pids.length ? ('held (' + pids.join(',') + ')') : 'not held');
}

const cmd = process.argv[2];
if (cmd === 'acquire') acquire();
else if (cmd === 'release') release();
else if (cmd === 'status') status();
else { console.error('usage: keepawake.js <acquire|release|status>'); process.exit(1); }
