#!/usr/bin/env node
'use strict';
/*
 * deadman-helper — the reboot/startup helper. Windows Task Scheduler runs it at
 * logon (see install-helper.ps1). It reads The Grave and, ONLY if a generation is
 * armed, its Resurrection Time has passed, and it isn't already resolved/rested,
 * resumes the EXACT session headlessly to run the recovery. This is the one path
 * that survives a full machine restart (in-session crons do not).
 *
 * SECURITY — the unattended resume runs with a SAFE, bounded permission set:
 *   --permission-mode acceptEdits (auto-approves file edits only) PLUS an
 *   --allowedTools allowlist scoped to deadman's OWN bookkeeping (grave.js) and
 *   the Cron tools. Everything else (arbitrary Bash, git push, builds) still
 *   requires approval and, with no human present, simply does not run — so the
 *   unattended resume RE-ARMS coverage and updates state, and defers real project
 *   work to a supervised session. It NEVER bypasses permissions silently. Full
 *   unattended autonomy is possible only by an explicit human opt-in (see README:
 *   set PERMISSION_MODE='bypassPermissions'), which carries real risk.
 *
 * Usage: node deadman-helper.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, execFileSync } = require('child_process');

// --- SECURITY knobs ---
const PERMISSION_MODE = 'acceptEdits';
const ALLOWED_TOOLS = [
  'Bash(node ~/.claude/deadman/grave.js:*)', // deadman's own Grave/Seal bookkeeping
  'CronCreate', 'CronList', 'CronDelete',    // re-arm coverage
].join(' ');
// NOTE: the exact allowedTools token syntax can vary by Claude Code version;
// verify with `claude --help` / a live test before relying on unattended runs.
const WATCHDOG_MS = 25 * 60 * 1000;
const FOLLOWUP_TASK = 'DeadmanRisesResume';

const DIR = path.join(os.homedir(), '.claude', 'deadman');
const GRAVE = path.join(DIR, 'grave.json');
const LOG = path.join(DIR, 'helper.log');
const DRY = process.argv.includes('--dry-run');

function log(m) { const line = `[${new Date().toISOString()}] ${m}`; try { fs.appendFileSync(LOG, line + '\n'); } catch (e) {} if (DRY) console.log(line); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }
function cmpV(a, b) { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (a[i] || 0) - (b[i] || 0); if (d) return d; } return 0; }

// Desktop-bundled claude.exe lives at a VERSION-numbered path that changes on
// every update — glob and pick the highest version, never hardcode.
function findClaude() {
  const base = path.join(os.homedir(), 'AppData', 'Roaming', 'Claude', 'claude-code');
  let best = null, bestV = null;
  try {
    for (const d of fs.readdirSync(base)) {
      const exe = path.join(base, d, 'claude.exe');
      if (fs.existsSync(exe)) {
        const v = d.split('.').map(n => parseInt(n, 10) || 0);
        if (!bestV || cmpV(v, bestV) > 0) { bestV = v; best = exe; }
      }
    }
  } catch (e) {}
  return best;
}

// #8 fix: an early logon (before the reset) must not permanently miss the resume.
// Schedule a one-time task at resurrection_time so the helper re-runs then.
function scheduleFollowup(epoch) {
  const d = new Date(epoch * 1000);
  const st = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const sd = `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
  const tr = `\"${process.execPath}\" \"${__filename}\"`;
  if (DRY) { log(`DRY-RUN: would schedule ${FOLLOWUP_TASK} once at ${sd} ${st} -> ${tr}`); return true; }
  try { execFileSync('schtasks', ['/create', '/tn', FOLLOWUP_TASK, '/tr', tr, '/sc', 'once', '/st', st, '/sd', sd, '/f'], { stdio: 'ignore' }); return true; }
  catch (e) { return false; }
}
function clearFollowup() { if (DRY) return; try { execFileSync('schtasks', ['/delete', '/tn', FOLLOWUP_TASK, '/f'], { stdio: 'ignore' }); } catch (e) {} }

function main() {
  const g = readJson(GRAVE);
  if (!g) { log('no grave; nothing to do'); return; }

  const now = Math.floor(Date.now() / 1000);
  const rested = g.seal && typeof g.seal.owner === 'string' && g.seal.owner.startsWith('rest@');
  const resolved = g.last_recovery_result && g.last_recovery_result.generation === g.generation &&
    ['resumed', 'all_clear', 'stopped'].includes(g.last_recovery_result.result);
  const pending = Array.isArray(g.rises) && g.rises.some(r => r && r.status === 'pending');
  const overdue = g.resurrection_time != null && g.resurrection_time <= now;

  if (rested || resolved || !pending) { clearFollowup(); log(`skip (rested=${rested} resolved=${resolved} pending=${pending})`); return; }

  if (!overdue) {
    // Armed + pending but the reset is still in the future (logon before reset).
    const ok = scheduleFollowup(g.resurrection_time);
    log(`not yet overdue; ${ok ? 'scheduled' : 'FAILED to schedule'} follow-up at ${new Date(g.resurrection_time * 1000).toISOString()}`);
    return;
  }

  if (!g.session_id) { log('no session_id in grave; cannot resume by id'); return; }
  const claude = findClaude();
  if (!claude) { log('claude.exe not found under AppData/Roaming/Claude/claude-code/*'); return; }

  const cwd = (g.project && fs.existsSync(g.project)) ? g.project : process.cwd();
  const prompt = `DEADMAN CHECK — startup resume (UNATTENDED, limited permissions), generation ${g.generation}, mode ${g.mode}. ` +
    `The machine restarted; this session was armed and its reset time has passed. Follow the deadman skill's Fired Rise ` +
    `protocol (role first): verify Life, claim the Seal, and re-arm coverage. Do project work ONLY if it needs no approval; ` +
    `if resuming would require commands beyond grave.js bookkeeping, record last_recovery_result detail "needs supervised ` +
    `resume" and STOP so the user can finish interactively. Never bypass permissions.`;
  const args = ['--resume', g.session_id, '-p', prompt, '--permission-mode', PERMISSION_MODE, '--allowedTools', ALLOWED_TOOLS];

  clearFollowup(); // this run IS the resume; drop any pending follow-up task
  log(`resume session=${g.session_id} cwd=${cwd} exe=${claude} permission-mode=${PERMISSION_MODE} allowedTools=[${ALLOWED_TOOLS}]`);
  if (DRY) { log('DRY-RUN: would spawn -> ' + [claude, ...args].map(a => a.includes(' ') ? `"${a}"` : a).join(' ')); return; }

  // stdio 'ignore' closes stdin (delivers EOF) — avoids the Windows headless
  // stdin-hang; the watchdog timeout force-kills a hung resume as defense in depth.
  const r = spawnSync(claude, args, { cwd, timeout: WATCHDOG_MS, stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });
  log(`resume exited status=${r.status} signal=${r.signal || ''} err=${r.error ? r.error.message : ''}`);
}

try { main(); } catch (e) { log('helper error: ' + (e && e.stack ? e.stack : String(e))); }
