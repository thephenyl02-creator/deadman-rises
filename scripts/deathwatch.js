#!/usr/bin/env node
/*
 * deadman / Death Watch — hook that auto-arms Deadman at the usage threshold.
 *
 * Wired to UserPromptSubmit (once per user turn) and PostToolUse (mid-turn
 * coverage for long autonomous runs). On each firing it reads usage.json
 * (written by statusline.js — the only reader of live rate_limits) and, when
 * the 5h window has crossed the threshold AND Deadman is not already armed for
 * this window, injects a self-contained DEATH WATCH instruction into context
 * via hookSpecificOutput.additionalContext. The main-loop model then arms the
 * existing First/Second Rise echelon (see the AUTO-EQUIP section of SKILL.md).
 *
 * OPT-IN GATE (the hook is installed globally; consent is per conversation):
 * Death Watch acts ONLY in a conversation that opted in by invoking /deadman
 * (which records the conversation's session_id in the Grave). The live
 * conversation's identity comes from THIS hook invocation's OWN stdin payload
 * (event.session_id) — never from usage.json, whose session block is written
 * by whichever terminal's status line refreshed last and can therefore name a
 * DIFFERENT conversation. No event session id → fail closed (consent cannot be
 * proven). No Grave, a rested Grave, or a Grave for another conversation →
 * exit silently. Auto-arming mid-work in a conversation that never asked for
 * deadman is an interruption, not a favor.
 *
 * SESSION STAMP: every invocation atomically records its own {session_id, cwd}
 * into session.json. `grave.js init` prefers this turn-local stamp (when
 * fresh) over usage.json's racy session block, so the Grave records the id of
 * the conversation actually invoking /deadman. The stamp is written BEFORE any
 * gate exit so it stays fresh in every conversation.
 *
 * STALENESS GUARD: usage.json is only trusted while fresh (statusline.js
 * rewrites it every refresh, so "fresh" means the status line is live RIGHT
 * NOW). A days-old reading — e.g. left behind by a terminal session on a
 * machine now using the desktop app, where no status line runs — must never
 * trigger an arm.
 *
 * Debounce: arming records the Grave (grave.js init/addrise), whose armed.json
 * shim carries armed_for_resets_at = the window's 5h reset. This hook stays
 * silent while that key matches the current window and re-activates when the
 * window rolls. A watching Grave (opted in, not yet armed) emits a null key so
 * it never debounces itself. Telemetry without a resets_at epoch → exit (there
 * is no meaningful time to arm for, and a null key can never debounce).
 *
 * It must NEVER break a turn: any error → exit 0 with no output.
 */
const fs = require('fs');
const path = require('path');

const DIR = path.join(require('os').homedir(), '.claude', 'deadman');
const USAGE = path.join(DIR, 'usage.json');
const ARMED = path.join(DIR, 'armed.json');
const GRAVE = path.join(DIR, 'grave.json');
const SESSJSON = path.join(DIR, 'session.json');
const THRESHOLD = 80;       // Last Breath threshold (% of 5h window)
const WINDOW = 'five_hour'; // Death Watch tracks the 5-hour window only
const MAX_AGE_S = 600;      // usage.json older than this is stale — ignore it

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch (e) { return ''; }
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}
// Best-effort atomic stamp (unique temp + rename, brief retry on AV-held files).
function stampSession(sessionId, cwd) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const tmp = `${SESSJSON}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      session_id: sessionId, cwd: cwd || null, updated_at: Math.floor(Date.now() / 1000),
    }));
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, SESSJSON); break; }
      catch (e) {
        if (i >= 3) { try { fs.unlinkSync(tmp); } catch (e2) {} break; }
      }
    }
  } catch (e) { /* stamping is a hint; never fail the hook over it */ }
}

try {
  let event = {};
  try { event = JSON.parse(readStdin() || '{}'); } catch (e) { event = {}; }
  const eventName = event.hook_event_name || event.hookEventName || 'UserPromptSubmit';

  // Authoritative identity of THIS conversation — from the hook's own payload.
  const liveSession = (typeof event.session_id === 'string' && event.session_id) ? event.session_id : null;
  if (liveSession) stampSession(liveSession, typeof event.cwd === 'string' ? event.cwd : null);

  const usage = readJson(USAGE);
  const win = usage && usage[WINDOW];
  if (!win || win.used_percentage == null) process.exit(0); // no telemetry (e.g. API-key session) → stay silent

  // Staleness: only a live status line writes usage.json continuously. An old
  // reading (terminal session ended; machine now on desktop/web) is not truth.
  const nowSec = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(usage.updated_at) || nowSec - usage.updated_at > MAX_AGE_S) process.exit(0);

  // Opt-in gate: only act in the conversation that invoked /deadman, proven by
  // the event payload. Fail closed when identity cannot be established.
  if (!liveSession) process.exit(0);
  const grave = readJson(GRAVE);
  if (!grave) process.exit(0); // nobody opted in
  if (grave.seal && typeof grave.seal.owner === 'string' && grave.seal.owner.startsWith('rest@')) {
    process.exit(0); // Rest in Peace — the opt-in ended with it
  }
  if (!grave.session_id || String(grave.session_id) !== liveSession) {
    process.exit(0); // a different conversation opted in — never interfere here
  }

  // Both values are interpolated into an instruction injected on every turn, so
  // coerce them to numbers here — a non-numeric resets_at would otherwise be
  // echoed verbatim into model context.
  const pct = Number(win.used_percentage);
  const resetsAt = Number.isInteger(win.resets_at) ? win.resets_at : null;
  if (resetsAt == null) process.exit(0); // no reset epoch → nothing to arm for (and null never debounces)
  if (!Number.isFinite(pct) || pct < THRESHOLD) process.exit(0);

  const armed = readJson(ARMED);
  if (armed && armed.armed_for_resets_at != null && armed.armed_for_resets_at === resetsAt) {
    process.exit(0); // already armed for this window
  }

  let resetHuman = 'the next reset';
  try { resetHuman = new Date(resetsAt * 1000).toLocaleString(); } catch (e) {}

  const msg =
    `DEATH WATCH AUTO-EQUIP TRIGGER (deadman skill — this conversation opted in via /deadman). ` +
    `The 5-hour usage window is at ${pct.toFixed(0)}% (auto-arm threshold ${THRESHOLD}%); it resets at ${resetHuman} (epoch ${resetsAt}). ` +
    `Per the deadman skill's AUTO-EQUIP protocol, act on this NOW, then continue with the user's request:\n` +
    `1. If CronList already shows Deadman jobs covering this window, skip to step 3.\n` +
    `2. Silently arm Deadman for THIS window per the skill's Arm procedure: First Rise at the exact reset (epoch ${resetsAt}), Second Rise +10 minutes, preserving whatever mode is already active (once / loop / soul). Do NOT ask for confirmation — arming is cheap and reversible.\n` +
    `3. Record it: \`grave.js init --mode <active mode> --reset ${resetsAt} --session ${liveSession}\` then \`grave.js addrise\` for both cron ids — this also writes the armed.json debounce so Death Watch stops re-firing for this window.\n` +
    `4. Tell the user exactly ONE line: "Death Watch: 5h usage ${pct.toFixed(0)}% — armed First/Second Rise for the reset at ${resetHuman}." Then resume their request normally.`;

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: eventName, additionalContext: msg },
  }));
} catch (e) {
  process.exit(0); // never break the turn
}
