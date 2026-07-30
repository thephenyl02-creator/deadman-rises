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
  // The temp name MUST be unique per writer. With a shared "<file>.tmp", two
  // concurrent writers interleave their writes into the same scratch file and
  // then both rename it into place — publishing a torn, unparseable Grave as
  // the source of truth. (Reproduced: 4 of 60 rounds with 4 writers.)
  const tmp = `${p}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    // Windows raises a transient EPERM/EBUSY when another process — commonly an
    // antivirus real-time scanner — has the destination open for a moment.
    // Measured at ~10% under concurrent writers, so retry briefly before failing.
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, p); break; }
      catch (e) {
        if (i >= 10 || (e.code !== 'EPERM' && e.code !== 'EBUSY' && e.code !== 'EACCES')) throw e;
        sleepMs(30);
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { /* best-effort cleanup */ }
    throw e;
  }
  sweepTemps(p);
}

// A hard kill between the write and the rename leaves a uniquely-named temp
// file that nothing else would ever remove. Sweep old ones opportunistically —
// only files clearly older than any in-flight write.
function sweepTemps(p) {
  try {
    const dir = path.dirname(p);
    const base = path.basename(p) + '.';
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith(base) || !f.endsWith('.tmp')) continue;
      const full = path.join(dir, f);
      try {
        if (Date.now() - fs.statSync(full).mtimeMs > 60000) fs.unlinkSync(full);
      } catch (e) { /* raced with another sweeper */ }
    }
  } catch (e) { /* sweeping is best-effort */ }
}

/*
 * Cross-process mutex for read-modify-write sequences on the Grave.
 *
 * atomicWrite (above) only prevents TORN files; it gives no mutual exclusion.
 * Without a lock, two Rises firing at the same second can both read
 * `seal.owner: null`, both decide WON, and both continue the same generation —
 * defeating the entire point of the Seal. fs.openSync(..., 'wx') is an atomic
 * create-if-absent on Windows and POSIX alike, so exactly one holder wins.
 *
 * A crashed holder cannot wedge the Grave forever: a lock older than
 * LOCK_STALE_MS is broken. Callers that cannot get the lock fall through and
 * run unlocked rather than failing the recovery — a missed lock is worse than
 * a missed Rise, but a dead Grave is worse than both.
 */
const LOCK = GRAVE + '.lock';
// The wait budget must EXCEED the stale threshold, or a waiter always gives up
// before it is allowed to break an abandoned lock and then runs unlocked —
// which silently defeats the mutex exactly when it matters most.
const LOCK_STALE_MS = 10000;                       // 10s → presumed abandoned
const LOCK_TRIES = 100;                            // ×150ms = 15s > 10s
const LOCK_WAIT_MS = 150;
// Written into the lock file so a holder only ever removes ITS OWN lock. Without
// this, a stalled holder whose lock was broken would delete the next holder's
// live lock on its way out, admitting two writers at once.
const LOCK_TOKEN = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;

function sleepMs(ms) {
  // Synchronous sleep without a dependency: block on an unshared buffer.
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
  catch (e) { const end = Date.now() + ms; while (Date.now() < end) { /* spin */ } }
}

/*
 * opts.tries   — how many LOCK_WAIT_MS attempts to make (default LOCK_TRIES).
 * opts.ifBusy  — what to do when the budget runs out:
 *                'run'  (default) proceed unlocked, warning on stderr — right
 *                       for a Rise, where losing the recovery is worse than a
 *                       racy write;
 *                'skip' give up and return undefined — right for the turn-end
 *                       hook, where the write is only a hint and a long stall
 *                       (or clobbering a live claim) is worse than losing it.
 */
function withGraveLock(fn, opts) {
  const o = opts || {};
  const tries = o.tries || LOCK_TRIES;
  // If the directory itself is unusable there is no lock to take. Honour the
  // caller's ifBusy rather than silently running unlocked — 'skip' exists
  // precisely to avoid an unlocked write.
  try { ensureDir(); } catch (e) { return o.ifBusy === 'skip' ? undefined : fn(); }
  for (let i = 0; i < tries; i++) {
    let fd = null;
    try { fd = fs.openSync(LOCK, 'wx'); }
    catch (e) {
      // EPERM/EBUSY/EACCES here are the same transient Windows conditions
      // atomicWrite retries (an AV scanner holding the file open); only a
      // genuinely unlockable filesystem should abandon locking.
      if (e.code !== 'EEXIST') {
        if (e.code === 'EPERM' || e.code === 'EBUSY' || e.code === 'EACCES') { sleepMs(LOCK_WAIT_MS); continue; }
        break;
      }
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(LOCK);
      } catch (e2) { /* someone else broke it first */ }
      sleepMs(LOCK_WAIT_MS);
      continue;
    }
    try {
      fs.writeSync(fd, LOCK_TOKEN);
      fs.closeSync(fd); fd = null;
      return fn();
    } finally {
      if (fd != null) { try { fs.closeSync(fd); } catch (e) {} }
      // Remove only OUR lock: if it was broken and re-taken while we ran, the
      // file on disk now belongs to someone else and must be left alone.
      try {
        if (fs.readFileSync(LOCK, 'utf8') === LOCK_TOKEN) fs.unlinkSync(LOCK);
      } catch (e) { /* already gone, or not ours */ }
    }
  }
  if (o.ifBusy === 'skip') return undefined;
  // Lock unavailable after the full budget: proceed rather than abandon a
  // recovery, but say so — a silent unlocked write is how corruption hides.
  try { process.stderr.write('grave: WARNING proceeding without lock\n'); } catch (e) {}
  return fn();
}

function blankGrave() {
  const t = nowSec();
  return {
    version: VERSION,
    session_id: null, project: null, project_key: null,
    generation: 0, mode: 'once', endless: false,
    watch: false,              // /deadman watch — opted in, not armed yet; Death Watch arms at threshold
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
  // A WATCHING grave (opted in, nothing armed yet) must NOT emit a window-keyed
  // debounce — that would silence Death Watch for the very window it is watching.
  const watching = !restful && g.watch === true && !(g.rises || []).some(r => r && r.status === 'pending');
  const mode = restful ? 'rest' : (watching ? 'watch' : (g.endless ? 'loop' : g.mode));
  // Debounce key MUST be the 5h reset (the window), NOT the fire time — else Death
  // Watch re-fires on any manual arm whose fire time differs from the reset.
  const key = watching ? null : (g.window_resets_at != null ? g.window_resets_at : g.resurrection_time);
  return { armed_for_resets_at: key, armed_at: g.updated_at, mode };
}

function writeGrave(g) {
  g.updated_at = nowSec();
  atomicWrite(GRAVE, g);
  try { atomicWrite(ARMED, armedShim(g)); } catch (e) { /* shim best-effort */ }
  return g;
}

// Claude Code encodes ~/.claude/projects/<key>/ by replacing every character
// that is not a letter or digit with '-'. Replacing only : \ / (as this did
// previously) is wrong for any path containing a space or a dot: measured
// against the real transcript directories on a live machine, the old transform
// matched 1 of 9 and this one matches all 9. `C:\Users\Ann Lee\.config` encodes
// as `C--Users-Ann-Lee--config`, not `C--Users-Ann Lee-.config`.
// NOTE: Claude Code additionally truncates keys over 200 characters and appends
// a hash, which is not reproduced here — so for very deep paths this value is
// informational only. Nothing security-relevant depends on it: the reboot
// helper anchors on the session transcript's recorded cwd instead.
function deriveProjectKey(cwd) {
  if (!cwd) return null;
  return String(cwd).replace(/[^a-zA-Z0-9]/g, '-');
}

function sessionFromUsage() {
  const u = readJson(USAGE) || {};
  return u.session || {};
}

/*
 * Which conversation is invoking us? Two sources, in trust order:
 *   1. session.json — stamped by the deathwatch hook from ITS OWN stdin payload
 *      on every turn/tool call of the ACTIVE conversation. Preferred while
 *      fresh: the stamp temporally closest to this init call is almost always
 *      from the very turn running it.
 *   2. usage.json's session block — written by whichever terminal's status line
 *      refreshed last; racy across concurrent terminals, so it is only the
 *      fallback (and the only source on installs without the hooks, where the
 *      race cannot matter because Death Watch is not installed either).
 * Residual race (documented in SKILL.md): two conversations actively mid-turn
 * in the same sub-second window can still cross-stamp. --session on the CLI
 * beats both sources and is race-free (the Death Watch trigger embeds it).
 */
const SESSJSON = path.join(DIR, 'session.json');
const SESS_FRESH_S = 120;
function resolveSession() {
  const s = readJson(SESSJSON);
  if (s && s.session_id && Number.isInteger(s.updated_at) && (nowSec() - s.updated_at) <= SESS_FRESH_S) {
    return { session_id: s.session_id, cwd: s.cwd || (sessionFromUsage().cwd || null) };
  }
  return sessionFromUsage();
}

/*
 * Untrusted text — upstream API error strings, and anything a local process
 * wrote into the Grave — is re-read by a model and printed to a terminal.
 *
 * Whitelist printable ASCII rather than blacklisting known-bad characters: it
 * covers real error messages and drops the entire injection class at once —
 * C0/C1 controls, the NEL / LINE SEPARATOR / PARAGRAPH SEPARATOR terminators
 * that a C0-only blacklist misses, zero-width and bidi-override characters, and
 * the invisible Unicode Tag block used to smuggle hidden ASCII past a reader.
 *
 * Double quotes go too: status.js renders some of these fields inside quotes,
 * and a value containing one can close its field and fake trailing fields.
 *
 * Over-long values are truncated from the MIDDLE: rate-limit messages put the
 * reset time at the end, which is the single most useful token in the string.
 * A value that sanitises away entirely (e.g. a wholly non-ASCII message) is
 * reported as unavailable rather than rendering as a confusing blank.
 */
function sanitizeText(v, max) {
  const limit = Math.max(8, Math.floor(max) || 200);
  const raw = String(typeof v === 'string' ? v : JSON.stringify(v) || '');
  let s = raw
    .replace(/[^\x20-\x7E]/g, ' ')   // printable ASCII only
    .replace(/[`<>"]/g, '')           // fence / markup / quote characters
    .replace(/\s+/g, ' ')
    .trim();
  // Marker still obeys the caller's limit — it is the one return path that
  // would otherwise exceed it.
  if (!s) return raw.trim() ? '(unprintable)'.slice(0, limit) : '';
  if (s.length > limit) {
    const head = Math.max(0, Math.floor(limit * 0.6) - 2);
    const tail = Math.max(0, limit - head - 3);
    s = s.slice(0, head) + '...' + s.slice(s.length - tail);
  }
  return s;
}

// Free-text fields anyone can write, cleaned before the Grave is handed to a
// model by `grave.js read`. Structural fields are deliberately not touched.
function sanitizeForRead(g) {
  const c = JSON.parse(JSON.stringify(g));
  if (c.last_failure && c.last_failure.reason != null) {
    c.last_failure.reason = sanitizeText(c.last_failure.reason, 200);
  }
  if (c.last_recovery_result && c.last_recovery_result.detail != null) {
    c.last_recovery_result.detail = sanitizeText(c.last_recovery_result.detail, 160);
  }
  if (typeof c.mode === 'string') c.mode = sanitizeText(c.mode, 24);
  if (typeof c.background === 'string') c.background = sanitizeText(c.background, 40);
  if (Array.isArray(c.rises)) {
    for (const r of c.rises) {
      if (!r) continue;
      if (typeof r.role === 'string') r.role = sanitizeText(r.role, 24);
      if (typeof r.status === 'string') r.status = sanitizeText(r.status, 24);
      if (typeof r.cron_id === 'string') r.cron_id = sanitizeText(r.cron_id, 64);
    }
  }
  if (c.seal && typeof c.seal.owner === 'string') c.seal.owner = sanitizeText(c.seal.owner, 64);
  return c;
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
  const sess = resolveSession();
  const usage = readJson(USAGE) || {};
  const g = blankGrave();
  g.session_id = f.session || sess.session_id || (prev && prev.session_id) || null;
  g.project = f.cwd || sess.cwd || (prev && prev.project) || null;
  g.project_key = deriveProjectKey(g.project);
  g.mode = f.mode || 'once';
  g.endless = (f.endless === 'true' || f.endless === true) || g.mode === 'loop';
  if (g.endless && g.mode === 'once') g.mode = 'loop';
  g.watch = (f.watch === 'true' || f.watch === true); // /deadman watch: opt in now, arm at threshold
  // A watch grave whose session cannot be identified is inert BY CONSTRUCTION:
  // the gate requires grave.session_id to match the live conversation, so a
  // null id means Death Watch never fires and the user is silently uncovered
  // after being told "watching". Refuse loudly instead (throw → CLI exit 1,
  // with the lock released by withGraveLock's finally).
  if (g.watch && !g.session_id) {
    throw new Error('watch refused: no session id available (no fresh session.json or usage.json session block) - ' +
      'Death Watch could never fire for this conversation. Arm immediately instead, or pass --session <id>.');
  }
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
      // `read` is the fired Rise's first action, so its output goes straight
      // into model context. JSON.stringify escapes only C0 controls, quote and
      // backslash — every class sanitizeText exists to block would otherwise
      // pass through here even though status.js and diagnose.js clean the same
      // fields. Sanitise the free-text ones on the way out; structural fields
      // (ids, epochs, paths) are left exact so they stay usable.
      case 'read': {
        const g = readGrave(); if (!g) die('no grave'); out(sanitizeForRead(g)); break;
      }
      // init reads prev.generation and writes a fresh Grave — a read-modify-write
      // like the rest, so it needs the same mutual exclusion.
      case 'init': out(withGraveLock(() => cmdInit(rest))); break;
      case 'set': out(withGraveLock(() => {
        const g = readGrave() || blankGrave();
        const dotpath = rest[0];
        const raw = rest.slice(1).join(' ');
        let value; try { value = JSON.parse(raw); } catch (e) { value = raw; }
        setPath(g, dotpath, value); return writeGrave(g);
      })); break;
      case 'addrise': out(withGraveLock(() => {
        const g = readGrave() || blankGrave();
        const [role, cronId, fire] = rest;
        g.rises = g.rises || [];
        g.rises.push({ role, cron_id: cronId, fire_time: parseInt(fire, 10), status: 'pending' });
        return writeGrave(g);
      })); break;
      // The Seal decides which Rise continues the work, so its whole
      // read-decide-write must be one critical section — see withGraveLock.
      case 'claim': out(withGraveLock(() => {
        const g = readGrave(); if (!g) return 'STALE';
        const [owner, gen] = rest;
        const r = claimSeal(g, owner, parseInt(gen, 10));
        if (r === 'WON' || r === 'TAKEOVER') {
          writeGrave(g);
          // Verify the claim actually landed: if anything raced past the lock,
          // report LOST rather than let two owners both believe they WON.
          const after = readGrave();
          if (!after || !after.seal || after.seal.owner !== owner) return 'LOST';
        }
        return r;
      })); break;
      case 'rearm': out(withGraveLock(() => {
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
        return writeGrave(g);
      })); break;
      case 'rest': out(withGraveLock(() => {
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
        // Preserve an all_clear the fired Rise just recorded for THIS generation
        // — "the chain ended because the work completed" is the ledger entry
        // /deadman status should keep showing, not the mechanical rest that
        // immediately follows it.
        const lr = g.last_recovery_result;
        if (!(lr && lr.generation === g.generation && lr.result === 'all_clear')) {
          g.last_recovery_result = { generation: g.generation, result: 'stopped', detail: 'rest', epoch: nowSec() };
        }
        return writeGrave(g);
      })); break;
      // Runs under the lock like every other mutation: deleting the Grave out
      // from under a live critical section is the same hazard as writing to it,
      // and the wrapper releases only OUR lock on the way out (an unconditional
      // unlink here would reopen the ownership hole LOCK_TOKEN closes).
      case 'clear': out(withGraveLock(() => {
        try { fs.unlinkSync(GRAVE); } catch (e) {}
        try { fs.unlinkSync(ARMED); } catch (e) {}
        return 'cleared';
      })); break;
      default:
        die('unknown command: ' + cmd + '\nusage: grave.js <init|read|set|addrise|claim|rearm|rest|clear>');
    }
  } catch (e) {
    die(e && e.stack ? e.stack : String(e));
  }
}

if (require.main === module) main();

module.exports = {
  DIR, GRAVE, ARMED, USAGE, SESSJSON, VERSION,
  nowSec, readJson, atomicWrite, blankGrave, readGrave, writeGrave,
  armedShim, deriveProjectKey, sessionFromUsage, resolveSession, setPath, claimSeal,
  withGraveLock, sanitizeText,
};
