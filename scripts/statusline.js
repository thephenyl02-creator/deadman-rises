#!/usr/bin/env node
/*
 * deadman / Death Watch — status line + usage telemetry bridge.
 *
 * Claude Code invokes this on every status-line refresh, piping the session
 * JSON (including rate_limits) on stdin. This is the ONLY place a script can
 * read the live 5h / 7d usage percentage + reset time, so it does two jobs:
 *   1. Persist the numbers to usage.json  (read later by deathwatch.js).
 *   2. Render a compact usage line for the human.
 *
 * It must never throw in a way that breaks the status line, so everything is
 * wrapped defensively and always prints *something*.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(require('os').homedir(), '.claude', 'deadman');
const USAGE = path.join(DIR, 'usage.json');
const ARMED = path.join(DIR, 'armed.json');
const THRESHOLD = 80; // Last Breath: auto-arm point for the 5h window

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
function color(s, code) { return `\x1b[${code}m${s}\x1b[0m`; }
function countdown(epoch) {
  if (!epoch) return '--';
  const secs = epoch - Math.floor(Date.now() / 1000);
  if (secs <= 0) return 'reset';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}

let data = {};
try { data = JSON.parse(readStdin() || '{}'); } catch (e) { data = {}; }

const rl = data.rate_limits || {};
const fh = rl.five_hour || {};
const sd = rl.seven_day || {};

// --- Persist telemetry for Death Watch (atomic write) ---
try {
  fs.mkdirSync(DIR, { recursive: true });
  const sessCwd = data.cwd || (data.workspace && (data.workspace.current_dir || data.workspace.project_dir)) || null;
  const state = {
    five_hour: (fh && fh.used_percentage != null)
      ? { used_percentage: fh.used_percentage, resets_at: fh.resets_at } : null,
    seven_day: (sd && sd.used_percentage != null)
      ? { used_percentage: sd.used_percentage, resets_at: sd.resets_at } : null,
    session: {
      session_id: data.session_id || null,
      cwd: sessCwd,
      // Same encoding as grave.js deriveProjectKey — Claude Code replaces every
      // non-alphanumeric character, not just : \ / . Keep the two in step.
      project_key: sessCwd ? String(sessCwd).replace(/[^a-zA-Z0-9]/g, '-') : null,
    },
    updated_at: Math.floor(Date.now() / 1000),
  };
  const tmp = USAGE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state));
  fs.renameSync(tmp, USAGE);
} catch (e) { /* never break the status line over a write failure */ }

// --- Render ---
// General-purpose line: <dir> · <model> · deadman usage. Every non-usage field
// is optional and defensively probed so a missing field never prints "undefined".
const parts = [];
const cwd = (data.workspace && (data.workspace.current_dir || data.workspace.project_dir)) || data.cwd || null;
if (cwd) { try { parts.push(color(path.basename(cwd), '34')); } catch (e) {} } // blue dir
const modelName = data.model && (data.model.display_name || data.model.name);
if (modelName) parts.push(color(modelName, '90')); // dim model
parts.push(color('deadman', '90'));
if (fh && fh.used_percentage != null) {
  const p = fh.used_percentage;
  const c = p >= THRESHOLD ? '31;1' : (p >= 60 ? '33' : '32'); // red / yellow / green
  const flag = p >= THRESHOLD ? '!' : '';
  parts.push(`5h ${color(`${p.toFixed(0)}%${flag}`, c)} (${countdown(fh.resets_at)})`);
} else {
  parts.push(`5h ${color('--', '90')}`);
}
if (sd && sd.used_percentage != null) {
  parts.push(color(`7d ${sd.used_percentage.toFixed(0)}%`, '90'));
}

// Show an armed marker if Deadman is currently armed for this window.
try {
  const armed = readJson(ARMED);
  if (armed && fh && armed.armed_for_resets_at === fh.resets_at) {
    parts.push(color('ARMED', '36;1'));
  }
} catch (e) { /* ignore */ }

process.stdout.write(parts.join('  '));
