#!/usr/bin/env node
'use strict';
/*
 * deadman / status — deterministic, pure renderer for `/deadman status`.
 *
 * No tool calls, no network. Reads grave.json + usage.json via grave.js's
 * module API and prints a human-readable status block to stdout. Any missing
 * field renders gracefully; this script never throws on bad/absent data.
 */
const G = require('./grave.js');

function fmtLocal(epoch) {
  if (epoch == null || typeof epoch !== 'number' || !isFinite(epoch)) return null;
  try { return new Date(epoch * 1000).toLocaleString(); } catch (e) { return null; }
}

// Countdown from now to a future epoch (seconds). "Xh YYm" / "Ym" / "reset".
function fmtCountdown(epoch) {
  if (epoch == null || typeof epoch !== 'number' || !isFinite(epoch)) return null;
  const now = G.nowSec();
  const diff = epoch - now;
  if (diff <= 0) return 'reset';
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${m}m`;
}

// "Age ago" from a past epoch (seconds) to now. "Xh" / "Ym" / "Ns".
function fmtAgo(epoch) {
  if (epoch == null || typeof epoch !== 'number' || !isFinite(epoch)) return null;
  const now = G.nowSec();
  const diff = Math.max(0, now - epoch);
  const h = Math.floor(diff / 3600);
  const m = Math.floor((diff % 3600) / 60);
  const s = diff % 60;
  if (h > 0) return `${h}h`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

function cap(s) {
  if (!s || typeof s !== 'string') return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function render(g, usage) {
  const lines = [];

  if (!g) {
    lines.push('Deadman: not armed (no Grave)');
    return lines.join('\n');
  }

  lines.push(`DEADMAN — generation ${g.generation != null ? g.generation : '?'}`);

  // Life line: 5h / 7d usage percentages + countdown to 5h reset.
  const fiveHour = usage && usage.five_hour;
  const sevenDay = usage && usage.seven_day;
  if (fiveHour || sevenDay) {
    let life = 'Life:              ';
    const parts = [];
    if (fiveHour && fiveHour.used_percentage != null) {
      const countdown = fmtCountdown(fiveHour.resets_at);
      parts.push(`5h ${fiveHour.used_percentage}%${countdown ? '  (' + countdown + ')' : ''}`);
    }
    if (sevenDay && sevenDay.used_percentage != null) {
      parts.push(`7d ${sevenDay.used_percentage}%`);
    }
    if (parts.length) lines.push(life + parts.join('   '));
  }

  // Resurrection Time
  if (g.resurrection_time != null) {
    const local = fmtLocal(g.resurrection_time);
    if (local) lines.push(`Resurrection Time: ${local}  (${g.resurrection_time})`);
  }

  // Rises
  if (Array.isArray(g.rises) && g.rises.length) {
    for (const r of g.rises) {
      if (!r) continue;
      const role = cap(r.role || 'rise');
      const status = r.status != null ? r.status : '?';
      const cronId = r.cron_id != null ? r.cron_id : '?';
      const fireLocal = fmtLocal(r.fire_time);
      lines.push(`${role} Rise:  ${status}   ${cronId}   ${fireLocal != null ? fireLocal : '?'}`);
    }
  }

  // Endless / Mode
  {
    const endless = g.endless ? 'on' : 'off';
    const mode = g.mode != null ? g.mode : '?';
    lines.push(`Endless Rise: ${endless}     Mode: ${mode}`);
  }

  // Background / Souls
  {
    const background = g.background != null ? g.background : 'unknown';
    let souls = '?';
    if (g.souls) {
      souls = g.souls.paid ? 'paid' : (g.souls.protected ? 'protected' : '?');
    }
    lines.push(`Background: ${background}     Souls: ${souls}`);
  }

  // Last recovery
  if (g.last_recovery_result) {
    const lr = g.last_recovery_result;
    const result = lr.result != null ? lr.result : '?';
    const gen = lr.generation != null ? lr.generation : '?';
    const detail = lr.detail != null ? lr.detail : '';
    const age = fmtAgo(lr.epoch);
    lines.push(`Last recovery: ${result} (gen ${gen}) — "${detail}"${age != null ? '  · ' + age + ' ago' : ''}`);
  } else {
    lines.push('Last recovery: none');
  }

  // Last failure
  if (g.last_failure) {
    const lf = g.last_failure;
    const type = lf.type != null ? lf.type : '?';
    const reason = lf.reason != null ? lf.reason : '';
    const age = fmtAgo(lf.epoch);
    lines.push(`Last failure:  ${type} — ${reason}${age != null ? '  · ' + age + ' ago' : ''}`);
  } else {
    lines.push('Last failure:  none');
  }

  return lines.join('\n');
}

function main() {
  let g = null, usage = null;
  try { g = G.readGrave(); } catch (e) { g = null; }
  try { usage = G.readJson(G.USAGE); } catch (e) { usage = null; }
  try {
    process.stdout.write(render(g, usage) + '\n');
  } catch (e) {
    process.stdout.write('Deadman: not armed (no Grave)\n');
  }
}

if (require.main === module) main();

module.exports = { render, fmtLocal, fmtCountdown, fmtAgo, cap };
