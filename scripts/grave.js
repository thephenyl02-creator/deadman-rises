#!/usr/bin/env node
'use strict';
/*
 * deadman / The Grave — durable local state for the recovery engine.
 *
 * One atomically-written JSON file (grave.json) is the single source of truth
 * for what is armed, in which generation, for which session, and what happened
 * last. Only the in-session model can arm (CronCreate is a model tool); this
 * helper just persists facts to disk so a later live turn (a fired Rise, a user
 * turn, a Death Watch injection) can read them and take the one privileged
 * action. See ~/.claude/deadman/README.md and the deadman SKILL.md.
 *
 * Also emits armed.json as a DERIVED shim every write, so the already-installed
 * statusline.js / deathwatch.js keep working unchanged (they read armed.json).
 *
 * Usable two ways:
 *   - CLI:    node grave.js <init|read|set|addrise|claim|rearm|rest|clear> ...
 *   - module: require('./grave.js') -> {readGrave, writeGrave, setPath, claimSeal, ...}
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DIR = path.join(os.homedir(), '.claude', 'deadman');
const GRAVE = path.join(DIR, 'grave.json');
const ARMED = path.join(DIR, 'armed.json');
const USAGE = path.join(DIR, 'usage.json');
const VERSION = 1;
// A seal whose claim is older than this, with no recorded progress, is presumed
// dead so a sibling may take over — the liveness escape for an owner that died
// WITHOUT emitting a StopFailure (hard kill / OOM / crash). Generous on purpose:
// longer than the +10min Second Rise, so a live owner working normally is never
// stolen from. A long-running owner refreshes its claim (same-owner re-claim
// updates claimed_at) to stay alive past this.
const STALE_TTL = 1800; // seconds (30 min)

function nowSec() { return Math.floor(Date.now() / 1000); }
function ensureDir() { fs.mkdirSync(DIR, { recursive: true }); }
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; } }

// Whole-object atomic write (temp + rename): a crash leaves either the old or
// the new complete file, never a torn one.
function atomicWrite(p, obj) {
  ensureDir();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function blankGrave() {
  const t = nowSec();
  return {
    version: VERSION,
    session_id: null, project: null, project_key: null,
    generation: 0, mode: 'once', endless: false,
    resurrection_time: null,   // the true FIRE time (for human display)
    window_resets_at: null,    // the 5h reset epoch — the Death Watch debounce key
    rises: [],
    seal: { owner: null, claimed_at: null },
    souls: { paid: false, protected: true },
    backoff: { kind: null, count: 0 },
    keep_awake: { held: false, policy: 'never' },
    background: 'unknown',
    last_recovery_result: null,
    last_failure: null,
    created_at: t, updated_at: t,
  };
}

function readGrave() { return readJson(GRAVE); }

// Derived shim so statusline.js (ARMED marker) and deathwatch.js (debounce)
// need no change. "rest@..." seal owner maps to mode:"rest" (Death Watch
// suppression for the window), matching the pre-Grave armed.json contract.
function armedShim(g) {
  const restful = g.seal && typeof g.seal.owner === 'string' && g.seal.owner.startsWith('rest@');
  const mode = restful ? 'rest' : (g.endless ? 'loop' : g.mode);
  // Debounce key MUST be the 5h reset (the window), NOT the fire time — else Death
  // Watch re-fires on any manual arm whose fire time differs from the reset.
  const key = g.window_resets_at != null ? g.window_resets_at : g.resurrection_time;
  return { armed_for_resets_at: key, armed_at: g.updated_at, mode };
}

function writeGrave(g) {
  g.updated_at = nowSec();
  atomicWrite(GRAVE, g);
  try { atomicWrite(ARMED, armedShim(g)); } catch (e) { /* shim best-effort */ }
  return g;
}

// Claude Code encodes ~/.claude/projects/<key>/ by replacing : \ / with -.
// Derive by that transform, then confirm the directory exists; fall back to the
// raw transform if the projects dir can't be scanned.
function deriveProjectKey(cwd) {
  if (!cwd) return null;
  const key = String(cwd).replace(/[\\/:]/g, '-');
  try {
    const projects = path.join(os.homedir(), '.claude', 'projects');
    if (fs.existsSync(path.join(projects, key))) return key;
  } catch (e) { /* ignore */ }
  return key;
}

function sessionFromUsage() {
  const u = readJson(USAGE) || {};
  return u.session || {};
}

// Set a dotpath (e.g. "rises.0.status") to a JSON value, creating containers.
function setPath(g, dotpath, value) {
  const parts = String(dotpath).split('.');
  let o = g;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (o[k] == null) o[k] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    o = o[k];
  }
  o[parts[parts.length - 1]] = value;
  return g;
}

/*
 * Grave Seal — one-winner compare-and-set. owner is "<role>@gen<N>".
 * Returns WON | LOST | STALE | TAKEOVER (does NOT persist — caller writes on
 * WON/TAKEOVER). A Rise must confirm Life returned BEFORE claiming, so a claim
 * means "I am taking over this generation", not merely "I fired".
 */
function claimSeal(g, owner, generation) {
  if (g.generation !== generation) return 'STALE';           // world moved on
  const s = g.seal || (g.seal = { owner: null, claimed_at: null });
  if (s.owner == null) { s.owner = owner; s.claimed_at = nowSec(); return 'WON'; }
  if (s.owner === owner) { s.claimed_at = nowSec(); return 'WON'; } // re-claim refreshes the heartbeat
  // Owned by a different owner:
  if (typeof s.owner === 'string' && s.owner.startsWith('rest@')) return 'LOST'; // rested — never resurrect, even past the TTL
  const lr = g.last_recovery_result;
  if (lr && lr.generation === generation && ['resumed', 'all_clear', 'rearmed'].includes(lr.result)) {
    return 'LOST';                                            // owner genuinely completed
  }
  const lf = g.last_failure;
  if (lf && s.claimed_at && lf.epoch > s.claimed_at) {        // owner claimed then died (instrumented)
    s.owner = owner; s.claimed_at = nowSec(); return 'TAKEOVER';
  }
  if (s.claimed_at && (nowSec() - s.claimed_at) > STALE_TTL) { // owner claim is stale — presumed dead
    s.owner = owner; s.claimed_at = nowSec(); return 'TAKEOVER';
  }
  return 'LOST';                                              // owner may still be working
}

// ---- CLI ----
function out(x) { process.stdout.write(typeof x === 'string' ? x + '\n' : JSON.stringify(x, null, 2) + '\n'); }
function die(msg) { process.stderr.write(String(msg) + '\n'); process.exit(1); }
function parseFlags(args) {
  const f = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] && args[i].startsWith('--')) {
      const k = args[i].slice(2);
      f[k] = (args[i + 1] != null && !String(args[i + 1]).startsWith('--')) ? args[++i] : true;
    }
  }
  return f;
}

function cmdInit(rest) {
  const f = parseFlags(rest);
  const prev = readGrave();
  const sess = sessionFromUsage();
  const usage = readJson(USAGE) || {};
  const g = blankGrave();
  g.session_id = f.session || sess.session_id || (prev && prev.session_id) || null;
  g.project = f.cwd || sess.cwd || (prev && prev.project) || null;
  g.project_key = deriveProjectKey(g.project);
  g.mode = f.mode || 'once';
  g.endless = (f.endless === 'true' || f.endless === true) || g.mode === 'loop';
  if (g.endless && g.mode === 'once') g.mode = 'loop';
  g.souls.paid = (g.mode === 'soul');
  g.resurrection_time = f.reset ? parseInt(f.reset, 10)
    : (usage.five_hour && usage.five_hour.resets_at != null ? usage.five_hour.resets_at : null);
  // Window key = the live 5h reset (for Death Watch debounce), independent of the
  // chosen fire time; falls back to the fire time when telemetry is absent.
  g.window_resets_at = (usage.five_hour && usage.five_hour.resets_at != null)
    ? usage.five_hour.resets_at : g.resurrection_time;
  // Endless re-arm of the SAME session bumps generation; a fresh arming is gen 1.
  if (prev && prev.session_id && g.session_id && prev.session_id === g.session_id && (prev.endless || prev.mode === 'loop')) {
    g.generation = (prev.generation || 0) + 1;
  } else {
    g.generation = 1;
  }
  if (prev && prev.created_at) g.created_at = prev.created_at;
  return writeGrave(g);
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  try {
    switch (cmd) {
      case 'read': {
        const g = readGrave(); if (!g) die('no grave'); out(g); break;
      }
      case 'init': out(cmdInit(rest)); break;
      case 'set': {
        const g = readGrave() || blankGrave();
        const dotpath = rest[0];
        const raw = rest.slice(1).join(' ');
        let value; try { value = JSON.parse(raw); } catch (e) { value = raw; }
        setPath(g, dotpath, value); out(writeGrave(g)); break;
      }
      case 'addrise': {
        const g = readGrave() || blankGrave();
        const [role, cronId, fire] = rest;
        g.rises = g.rises || [];
        g.rises.push({ role, cron_id: cronId, fire_time: parseInt(fire, 10), status: 'pending' });
        out(writeGrave(g)); break;
      }
      case 'claim': {
        const g = readGrave(); if (!g) { out('STALE'); break; }
        const [owner, gen] = rest;
        const r = claimSeal(g, owner, parseInt(gen, 10));
        if (r === 'WON' || r === 'TAKEOVER') writeGrave(g);
        out(r); break;
      }
      case 'rearm': {
        const f = parseFlags(rest);
        const g = readGrave() || blankGrave();
        const prevGen = g.generation || 0;
        g.generation = prevGen + 1;
        g.rises = [];
        g.seal = { owner: null, claimed_at: null };
        g.backoff = { kind: null, count: 0 };
        g.last_failure = null; // fresh window — clear the stale failure that caused the prior stall
        if (f.reset) g.resurrection_time = parseInt(f.reset, 10);
        const ru = readJson(USAGE) || {};
        if (ru.five_hour && ru.five_hour.resets_at != null) g.window_resets_at = ru.five_hour.resets_at;
        g.last_recovery_result = { generation: prevGen, result: 'rearmed', detail: 'endless re-arm', epoch: nowSec() };
        out(writeGrave(g)); break;
      }
      case 'rest': {
        const g = readGrave() || blankGrave();
        (g.rises || []).forEach(r => { r.status = 'deleted'; });
        g.endless = false;
        g.seal = { owner: 'rest@gen' + (g.generation || 0), claimed_at: nowSec() };
        const usage = readJson(USAGE) || {};
        // Suppress Death Watch for the CURRENT window (debounce key), leaving the
        // human-facing resurrection_time (fire time) untouched.
        if (usage.five_hour && usage.five_hour.resets_at != null) g.window_resets_at = usage.five_hour.resets_at;
        g.backoff = { kind: null, count: 0 };
        g.keep_awake = g.keep_awake || { held: false, policy: 'never' };
        g.keep_awake.held = false;
        g.last_recovery_result = { generation: g.generation, result: 'stopped', detail: 'rest', epoch: nowSec() };
        out(writeGrave(g)); break;
      }
      case 'clear': {
        try { fs.unlinkSync(GRAVE); } catch (e) {}
        try { fs.unlinkSync(ARMED); } catch (e) {}
        out('cleared'); break;
      }
      default:
        die('unknown command: ' + cmd + '\nusage: grave.js <init|read|set|addrise|claim|rearm|rest|clear>');
    }
  } catch (e) {
    die(e && e.stack ? e.stack : String(e));
  }
}

if (require.main === module) main();

module.exports = {
  DIR, GRAVE, ARMED, USAGE, VERSION,
  nowSec, readJson, atomicWrite, blankGrave, readGrave, writeGrave,
  armedShim, deriveProjectKey, sessionFromUsage, setPath, claimSeal,
};
